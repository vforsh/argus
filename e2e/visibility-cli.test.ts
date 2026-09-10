import { afterEach, expect, test } from 'bun:test'
import path from 'node:path'
import { runCommandWithExit } from './helpers/process.js'
import { startStubWatcher, type StubWatcher } from './helpers/stubWatcher.js'

const BIN_PATH = path.resolve('packages/argus/dist/bin.js')
let stub: StubWatcher | undefined

afterEach(async () => {
	await stub?.close()
	stub = undefined
})

for (const flags of [['--policy', 'background'], ['--no-activate']]) {
	test(`page show ${flags.join(' ')} refuses an old watcher without activating it`, async () => {
		stub = await startStubWatcher(
			{
				'GET /visibility': { status: 404, payload: { ok: false, error: { code: 'not_found', message: 'Not found' } } },
				// An older watcher would ignore the unknown options and activate here.
				'POST /visibility': { payload: { ok: true, attached: true, state: 'shown' } },
			},
			'visibility-cli',
		)
		const result = await runCommandWithExit('bun', [BIN_PATH, 'page', 'show', stub.watcherId, ...flags, '--json'], {
			env: { ...process.env, ARGUS_HOME: path.dirname(stub.registryPath), ARGUS_REGISTRY_PATH: stub.registryPath },
		})
		expect(result.code).not.toBe(0)
		const response = JSON.parse(result.stdout)
		expect(response).toMatchObject({ ok: false, error: { code: 'not_available' } })
		expect(response.error.message).toMatch(/restart/i)
		expect(stub.calls.map((call) => call.method)).toEqual(['GET'])
	})
}
