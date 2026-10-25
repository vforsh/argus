import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import {
	createEmptyRegistry, readActiveRegistry, readAndPruneRegistry, updateRegistry, setWatcherEntry,
	removeWatcherAndPersist, createWatcherResolver, delay, type RegistryV1,
} from '@vforsh/argus-core'
import { createArgusClient } from '@vforsh/argus-client'
import { useCleanup } from '../helpers/cleanup.js'
import { argusEnv, createCli } from '../helpers/cli.js'
import { BIN_PATH, BUNDLE_PATH } from '../helpers/paths.js'
import { spawnAndWait, stopProcess } from '../helpers/process.js'
import { startSession } from '../helpers/session.js'
import { startStubWatcher, evalJsonResponse } from '../helpers/stubWatcher.js'
import { makeTempDir, removeDir, useTempDirs } from '../helpers/tempDir.js'
import { TIMEOUTS } from '../helpers/timeouts.js'
import { startFixtureWatcher } from '../helpers/watcher.js'
import { startWatcher } from '../../packages/argus-watcher/src/index.js'

setDefaultTimeout(TIMEOUTS.process)

describe('registry discovery', () => {
	const defer = useCleanup()
	const tempDir = useTempDirs('argus-discovery')
	const routes = { 'GET /status': { payload: { ok: true, protocolVersion: 2 } }, 'POST /eval': evalJsonResponse('old') }

	const fixture = async () => {
		const dir = await tempDir()
		const registryPath = path.join(dir, 'registry.json')
		const now = Date.now()
		const live = { id: 'live', ownerId: 'one', host: '127.0.0.1', port: 1, pid: process.pid, startedAt: now, updatedAt: now }
		const registry: RegistryV1 = {
			...createEmptyRegistry(now), watchers: { live, stale: { ...live, id: 'stale', updatedAt: now - 60_001 } },
			reservations: {
				live: { id: 'live', pid: process.pid, ownerId: 'live-reservation', reservedAt: now },
				stale: { id: 'stale', pid: process.pid, ownerId: 'stale-reservation', reservedAt: now - 60_001 },
			},
		}
		await fs.writeFile(registryPath, JSON.stringify(registry))
		return { dir, registryPath, registry, live }
	}

	test('eight concurrent discoveries ignore the writer lock, filter TTL locally, and never write/prune', async () => {
		const { registryPath } = await fixture()
		const original = await fs.readFile(registryPath, 'utf8')
		const before = await fs.stat(registryPath)
		await fs.writeFile(registryPath + '.lock', '')
		try {
			const snapshots = await Promise.all(Array.from({ length: 8 }, () => readActiveRegistry({ registryPath })))
			for (const snapshot of snapshots) {
				expect(Object.keys(snapshot.watchers)).toEqual(['live'])
				expect(Object.keys(snapshot.reservations!)).toEqual(['live'])
			}
			expect(await fs.readFile(registryPath, 'utf8')).toBe(original)
			expect((await fs.stat(registryPath)).mtimeMs).toBe(before.mtimeMs)
		} finally { await fs.unlink(registryPath + '.lock') }
		await readAndPruneRegistry({ registryPath })
		const persisted = JSON.parse(await fs.readFile(registryPath, 'utf8')) as RegistryV1
		expect(Object.keys(persisted.watchers)).toEqual(['live'])
		expect(Object.keys(persisted.reservations!)).toEqual(['live'])
	})

	test('snapshot readers tolerate a replacement gap and see concurrent writer/heartbeat updates without lost entries', async () => {
		const { registryPath, live } = await fixture()
		await fs.writeFile(registryPath + '.lock', '')
		await fs.rename(registryPath, registryPath + '.replacing')
		const replacement = new Promise<void>((resolve) => setTimeout(() => {
			void fs.rename(registryPath + '.replacing', registryPath).then(() => fs.unlink(registryPath + '.lock')).then(() => resolve())
		}, 20))
		expect((await readActiveRegistry({ registryPath })).watchers.live?.ownerId).toBe('one')
		await replacement
		await Promise.all(Array.from({ length: 8 }, (_, i) => updateRegistry((registry) => setWatcherEntry(registry,
			{ ...live, id: 'writer-' + i, updatedAt: Date.now() }), registryPath)))
		await updateRegistry((registry) => setWatcherEntry(registry, { ...registry.watchers.stale!, updatedAt: Date.now() }), registryPath)
		const snapshot = await readActiveRegistry({ registryPath })
		expect(Object.keys(snapshot.watchers)).toHaveLength(10)
		expect(snapshot.watchers.stale).toBeDefined()
	})

	test('conditional eviction keeps replacement owners, legacy starts and changed endpoints', async () => {
		const { registryPath, live } = await fixture()
		for (const replacement of [
			{ ...live, ownerId: 'two' }, { ...live, startedAt: live.startedAt + 1 }, { ...live, port: live.port + 1 },
		]) {
			await updateRegistry((registry) => setWatcherEntry(registry, replacement), registryPath)
			await removeWatcherAndPersist('live', registryPath, live)
			expect((await readActiveRegistry({ registryPath })).watchers.live).toEqual(replacement)
		}
	})

	test('resolver refreshes expired snapshots and never serves a record past its heartbeat TTL', async () => {
		const { registryPath, live } = await fixture()
		const resolver = createWatcherResolver({ registryPath, ttlMs: 20 })
		expect((await resolver.snapshot()).watchers.live).toBeDefined()
		await Bun.sleep(30)
		expect((await resolver.snapshot()).watchers.live).toBeUndefined()
		await updateRegistry((registry) => setWatcherEntry(registry, { ...live, updatedAt: Date.now() }), registryPath)
		expect((await resolver.snapshot(true)).watchers.live).toBeDefined()
	})

	for (const transport of ['sdk', 'session'] as const) {
		test(`${transport}: a lost mutation reply does not replay or evict a replacement run; next request reconnects`, async () => {
			const old = await startStubWatcher({ ...routes, 'POST /eval': { ...evalJsonResponse('old'), delayMs: 500 } }, 'app')
			const next = await startStubWatcher({ ...routes, 'POST /eval': evalJsonResponse('new') }, 'app')
			defer(old.close)
			defer(next.close)
			const client = createArgusClient({ registryPath: old.registryPath })
			const env = argusEnv(old.home, { ARGUS_REGISTRY_PATH: old.registryPath, ARGUS_PLUGINS: '' })
			const session = transport === 'session' ? startSession(BUNDLE_PATH, ['app'], { env, cwd: old.home }) : undefined
			if (session) { defer(() => session.close()); expect(await session.next()).toMatchObject({ type: 'ready' }) }
			const request = () => {
				if (!session) return client.evalValue('app', 'mutate()').then((value) => ({ ok: true, value }), () => ({ ok: false }))
				session.send({ id: 1, cmd: 'eval', args: { expression: 'mutate()' } })
				return session.next()
			}
			const failed = request()
			while (old.calls.length === 0) await Bun.sleep(2)
			await old.writeRegistry(await next.readRegistry())
			await old.stopServer() // Request reached the old server; its response is now unknowable.
			expect(await failed).toMatchObject({ ok: false })
			expect(old.calls.filter((call) => call.path === '/eval')).toHaveLength(1)
			expect(next.calls.filter((call) => call.path === '/eval')).toHaveLength(0)
			expect((await old.readRegistry()).watchers.app?.port).toBe((await next.readRegistry()).watchers.app?.port)
			expect(await request()).toMatchObject({ ok: true })
			expect(next.calls.filter((call) => call.path === '/eval')).toHaveLength(1)
		})
	}

	test('SDK list refreshes discovery before probing newly registered endpoints', async () => {
		const old = await startStubWatcher({ ...routes, 'GET /status': { payload: { ok: true, protocolVersion: 2, attached: false } } }, 'app')
		const next = await startStubWatcher({ ...routes, 'GET /status': { payload: { ok: true, protocolVersion: 2, attached: true } } }, 'app')
		defer(old.close)
		defer(next.close)
		const client = createArgusClient({ registryPath: old.registryPath })
		await client.evalValue('app', '1') // Prime the previous healthy endpoint inside the 250ms window.
		await old.writeRegistry(await next.readRegistry())
		const listed = await client.list()
		expect(listed[0]?.watcher.port).toBe((await next.readRegistry()).watchers.app?.port)
		expect(listed[0]?.status?.attached).toBe(true)
		expect(old.calls.filter((call) => call.path === '/status')).toHaveLength(0)
		expect(next.calls.filter((call) => call.path === '/status')).toHaveLength(1)
		await client.evalValue('app', '1')
		expect(next.calls.filter((call) => call.path === '/eval')).toHaveLength(1)
	})

	test('ordinary CLI and SDK discovery do not physically prune stale registry entries', async () => {
		const stub = await startStubWatcher(routes, 'app')
		defer(stub.close)
		const registry = await stub.readRegistry()
		registry.watchers.stale = { ...registry.watchers.app!, id: 'stale', updatedAt: Date.now() - 60_001 }
		await stub.writeRegistry(registry)
		const before = await fs.readFile(stub.registryPath, 'utf8')
		await createArgusClient({ registryPath: stub.registryPath }).evalValue('app', '1')
		const cli = createCli({ bin: BUNDLE_PATH, env: argusEnv(stub.home, { ARGUS_REGISTRY_PATH: stub.registryPath, ARGUS_PLUGINS: '' }) })
		const result = await cli.exec(['eval', 'app', '1', '--json'])
		expect(result.code).toBe(0)
		expect(await fs.readFile(stub.registryPath, 'utf8')).toBe(before)
	})
})

/**
 * Registry ownership under concurrency (issue #18, phase 1). No browser: watchers point at a
 * closed CDP port and only exercise registration.
 *
 * - An explicit id means exactly that id: concurrent starts yield one owner and `watcher_id_taken`.
 * - Auto-named watchers (`idConflict: 'suffix'`, as extension controls use) get distinct ids.
 * - Only the owner refreshes or removes its record; a foreign holder is never overwritten or deleted.
 */
describe('watcher registry ownership', () => {
	const CONCURRENCY = 4

	let tempDir: string
	let registryPath: string
	let env: NodeJS.ProcessEnv
	const spawned: ChildProcess[] = []

	beforeEach(async () => {
		tempDir = await makeTempDir('argus-registry-e2e')
		registryPath = path.join(tempDir, 'registry.json')
		env = argusEnv(tempDir, { ARGUS_REGISTRY_PATH: registryPath })
	})

	afterEach(async () => {
		await Promise.all(spawned.splice(0).map((proc) => stopProcess(proc)))
		await removeDir(tempDir)
	})

	const readRegistryFile = async (): Promise<RegistryV1> => JSON.parse(await fs.readFile(registryPath, 'utf8')) as RegistryV1

	/** Start the SDK fixture and wait for it to print its record. */
	const startFixture = async (config: Record<string, unknown>): Promise<{ proc: ChildProcess; id: string }> => {
		const { proc, id } = await startFixtureWatcher(
			{ chrome: { host: '127.0.0.1', port: 1 }, pageIndicator: { enabled: false }, ...config },
			{ env, waitForAttach: false },
		)
		spawned.push(proc)
		return { proc, id }
	}

	test('concurrent `watcher start --id x` yields one owner and watcher_id_taken for the rest', async () => {
		const runs = Array.from({ length: CONCURRENCY }, () =>
			spawnAndWait('node', [BIN_PATH, 'watcher', 'start', '--id', 'race', '--chrome-port', '1', '--no-page-indicator'], { env }, /id=race/).then(
				(started) => {
					spawned.push(started.proc)
					return { ok: true as const, pid: started.proc.pid }
				},
				(error: Error) => ({ ok: false as const, message: error.message }),
			),
		)
		const results = await Promise.all(runs)

		const winners = results.filter((result) => result.ok)
		const losers = results.filter((result) => !result.ok)
		expect(winners).toHaveLength(1)
		expect(losers).toHaveLength(CONCURRENCY - 1)
		for (const loser of losers) {
			expect(loser.message).toContain('Watcher id "race" is already in use')
		}

		const registry = await readRegistryFile()
		expect(Object.keys(registry.watchers)).toEqual(['race'])
		expect(registry.watchers.race.pid).toBe(winners[0].pid!)
		expect(registry.watchers.race.ownerId).toBeTruthy()
		expect(registry.reservations?.race).toBeUndefined()
	})

	test('concurrent auto-named watchers get distinct ids; stopping one leaves the others intact', async () => {
		const started = await Promise.all(Array.from({ length: CONCURRENCY }, () => startFixture({ id: 'auto', idConflict: 'suffix' })))

		const ids = started.map((entry) => entry.id).sort()
		expect(ids).toEqual(['auto', 'auto-2', 'auto-3', 'auto-4'])

		const registry = await readRegistryFile()
		expect(Object.keys(registry.watchers).sort()).toEqual(ids)
		for (const entry of started) {
			expect(registry.watchers[entry.id].pid).toBe(entry.proc.pid!)
		}
		expect(new Set(Object.values(registry.watchers).map((watcher) => watcher.ownerId)).size).toBe(CONCURRENCY)

		const victim = started.find((entry) => entry.id === 'auto')!
		await stopProcess(victim.proc)
		const after = await readRegistryFile()
		expect(Object.keys(after.watchers).sort()).toEqual(['auto-2', 'auto-3', 'auto-4'])
		for (const entry of started.filter((candidate) => candidate !== victim)) {
			expect(after.watchers[entry.id]).toEqual(registry.watchers[entry.id])
		}
	})

	test('heartbeat and shutdown never overwrite or remove a record held by another owner', async () => {
		const { proc, id } = await startFixture({ id: 'owned', heartbeatMs: 100 })

		// Simulate a legacy host (no ownerId) that blindly overwrote the key while both are alive.
		const registry = await readRegistryFile()
		const foreign = { ...registry.watchers[id], pid: process.pid, port: 1, ownerId: undefined, updatedAt: Date.now() }
		await fs.writeFile(registryPath, JSON.stringify({ ...registry, watchers: { [id]: foreign } }, null, 2))

		await delay(500)
		expect((await readRegistryFile()).watchers[id]).toEqual(JSON.parse(JSON.stringify(foreign)))

		await stopProcess(proc)
		expect((await readRegistryFile()).watchers[id]).toEqual(JSON.parse(JSON.stringify(foreign)))
	})

	test('an explicit id frees up once its previous owner exits', async () => {
		const first = await startFixture({ id: 'reuse' })
		const stopping = stopProcess(first.proc)
		const second = await startFixture({ id: 'reuse' })
		await stopping
		expect(second.id).toBe('reuse')

		const status = await createCli({ runtime: 'node', env }).exec(['watcher', 'status', 'reuse', '--json'])
		expect((JSON.parse(status.stdout) as { pid: number }).pid).toBe(second.proc.pid!)
	})

	test('close drains a heartbeat blocked on the registry lock while the owning PID stays alive', async () => {
		const previousHome = process.env.ARGUS_HOME
		const previousRegistry = process.env.ARGUS_REGISTRY_PATH
		process.env.ARGUS_HOME = tempDir
		process.env.ARGUS_REGISTRY_PATH = registryPath
		const handle = await startWatcher({
			id: 'close-race',
			chrome: { host: '127.0.0.1', port: 1 },
			heartbeatMs: 50,
			pageIndicator: { enabled: false },
		})
		try {
			await fs.writeFile(`${registryPath}.lock`, '')
			const before = handle.watcher.updatedAt
			const deadline = Date.now() + 2_000
			while (handle.watcher.updatedAt === before && Date.now() < deadline) await delay(10)
			expect(handle.watcher.updatedAt).toBeGreaterThan(before)
			let closed = false
			const closing = handle.close().then(() => {
				closed = true
			})
			await delay(100)
			expect(closed).toBe(false)
			await fs.unlink(`${registryPath}.lock`)
			await closing
			expect((await readRegistryFile()).watchers[handle.watcher.id]).toBeUndefined()
			await delay(250)
			expect((await readRegistryFile()).watchers[handle.watcher.id]).toBeUndefined()
		} finally {
			await fs.rm(`${registryPath}.lock`, { force: true })
			await handle.close()
			if (previousHome == null) delete process.env.ARGUS_HOME
			else process.env.ARGUS_HOME = previousHome
			if (previousRegistry == null) delete process.env.ARGUS_REGISTRY_PATH
			else process.env.ARGUS_REGISTRY_PATH = previousRegistry
		}
	})
})
