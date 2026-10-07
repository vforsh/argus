import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
	createEmptyRegistry, readActiveRegistry, readAndPruneRegistry, updateRegistry, setWatcherEntry,
	removeWatcherAndPersist, createWatcherResolver, type RegistryV1,
} from '@vforsh/argus-core'
import { createArgusClient } from '@vforsh/argus-client'
import { startStubWatcher, evalJsonResponse } from './helpers/stubWatcher.js'
import { startSession } from './helpers/session.js'
import { runCommandWithExit } from './helpers/process.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const bin = path.resolve('packages/argus/dist/argus.js')
const routes = { 'GET /status': { payload: { ok: true, protocolVersion: 2 } }, 'POST /eval': evalJsonResponse('old') }

const fixture = async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-discovery-'))
	cleanup.push(() => fs.rm(dir, { recursive: true, force: true }))
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
		cleanup.push(old.close, next.close)
		const client = createArgusClient({ registryPath: old.registryPath })
		const env = { ...process.env, ARGUS_HOME: path.dirname(old.registryPath), ARGUS_REGISTRY_PATH: old.registryPath, ARGUS_PLUGINS: '' }
		const session = transport === 'session' ? startSession(bin, ['app'], { env, cwd: path.dirname(old.registryPath) }) : undefined
		if (session) { cleanup.push(() => session.close()); expect(await session.next()).toMatchObject({ type: 'ready' }) }
		const request = () => {
			if (!session) return client.evalValue('app', 'mutate()').then((value) => ({ ok: true, value }), () => ({ ok: false }))
			session.send({ id: 1, cmd: 'eval', args: { expression: 'mutate()' } })
			return session.next()
		}
		const failed = request()
		while (old.calls.length === 0) await Bun.sleep(2)
		await fs.writeFile(old.registryPath, JSON.stringify(await next.readRegistry()))
		await old.stopServer() // Request reached the old server; its response is now unknowable.
		expect(await failed).toMatchObject({ ok: false })
		expect(old.calls.filter((call) => call.path === '/eval')).toHaveLength(1)
		expect(next.calls.filter((call) => call.path === '/eval')).toHaveLength(0)
		expect((await old.readRegistry()).watchers.app?.port).toBe((await next.readRegistry()).watchers.app?.port)
		expect(await request()).toMatchObject({ ok: true })
		expect(next.calls.filter((call) => call.path === '/eval')).toHaveLength(1)
	}, 10_000)
}

test('SDK list refreshes discovery before probing newly registered endpoints', async () => {
	const old = await startStubWatcher({ ...routes, 'GET /status': { payload: { ok: true, protocolVersion: 2, attached: false } } }, 'app')
	const next = await startStubWatcher({ ...routes, 'GET /status': { payload: { ok: true, protocolVersion: 2, attached: true } } }, 'app')
	cleanup.push(old.close, next.close)
	const client = createArgusClient({ registryPath: old.registryPath })
	await client.evalValue('app', '1') // Prime the previous healthy endpoint inside the 250ms window.
	await fs.writeFile(old.registryPath, JSON.stringify(await next.readRegistry()))
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
	cleanup.push(stub.close)
	const registry = await stub.readRegistry()
	registry.watchers.stale = { ...registry.watchers.app!, id: 'stale', updatedAt: Date.now() - 60_001 }
	await fs.writeFile(stub.registryPath, JSON.stringify(registry))
	const before = await fs.readFile(stub.registryPath, 'utf8')
	await createArgusClient({ registryPath: stub.registryPath }).evalValue('app', '1')
	const result = await runCommandWithExit('bun', [bin, 'eval', 'app', '1', '--json'], {
		env: { ...process.env, ARGUS_HOME: path.dirname(stub.registryPath), ARGUS_REGISTRY_PATH: stub.registryPath, ARGUS_PLUGINS: '' },
	})
	expect(result.code).toBe(0)
	expect(await fs.readFile(stub.registryPath, 'utf8')).toBe(before)
})
