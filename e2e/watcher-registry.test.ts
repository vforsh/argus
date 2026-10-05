/**
 * Registry ownership under concurrency (issue #18, phase 1). No browser: watchers point at a
 * closed CDP port and only exercise registration.
 *
 * - An explicit id means exactly that id: concurrent starts yield one owner and `watcher_id_taken`.
 * - Auto-named watchers (`idConflict: 'suffix'`, as extension controls use) get distinct ids.
 * - Only the owner refreshes or removes its record; a foreign holder is never overwritten or deleted.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { delay, type RegistryV1 } from '@vforsh/argus-core'
import { runCommandWithExit, spawnAndWait, stopProcess } from './helpers/process.js'

const BIN_PATH = path.resolve('packages/argus/dist/bin.js')
const FIXTURE_WATCHER = path.resolve('e2e/fixtures/start-watcher.ts')
const CONCURRENCY = 4

let tempDir: string
let registryPath: string
let env: NodeJS.ProcessEnv
const spawned: ChildProcess[] = []

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-registry-e2e-'))
	registryPath = path.join(tempDir, 'registry.json')
	env = { ...process.env, ARGUS_HOME: tempDir, ARGUS_REGISTRY_PATH: registryPath }
})

afterEach(async () => {
	await Promise.all(spawned.splice(0).map((proc) => stopProcess(proc)))
	await fs.rm(tempDir, { recursive: true, force: true })
})

const readRegistryFile = async (): Promise<RegistryV1> => JSON.parse(await fs.readFile(registryPath, 'utf8')) as RegistryV1

/** Start the SDK fixture and wait for it to print its record. */
const startFixture = async (config: Record<string, unknown>): Promise<{ proc: ChildProcess; id: string }> => {
	const { proc, stdout } = await spawnAndWait(
		'bun',
		[FIXTURE_WATCHER, JSON.stringify({ chrome: { host: '127.0.0.1', port: 1 }, pageIndicator: { enabled: false }, ...config })],
		{ env },
		/\{"id":/,
	)
	spawned.push(proc)
	return { proc, id: (JSON.parse(stdout.trim().split('\n')[0]) as { id: string }).id }
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

	const status = await runCommandWithExit('node', [BIN_PATH, 'watcher', 'status', 'reuse', '--json'], { env })
	expect((JSON.parse(status.stdout) as { pid: number }).pid).toBe(second.proc.pid!)
})
