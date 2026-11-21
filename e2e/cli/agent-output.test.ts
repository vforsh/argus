import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { useCleanup } from '../helpers/cleanup.js'
import { argusEnv, createCli } from '../helpers/cli.js'
import { startStubWatcher, type StubRoutes, type StubWatcher } from '../helpers/stubWatcher.js'
import { TIMEOUTS } from '../helpers/timeouts.js'

setDefaultTimeout(TIMEOUTS.process)

/** Agent-facing output contracts against a stub watcher: `run -e`, `net` data: URIs, compact `list`. */

const STATUS_REPLY = {
	payload: { ok: true, attached: true, protocolVersion: 2, watcherVersion: '0.0.0-test', target: { title: 'A page title that is quite long, longer than forty chars', url: 'http://localhost:3000/x' } },
}

const DATA_URI = `data:image/png;base64,${'A'.repeat(1998)}==`
const netRequest = (id: number, url: string) => ({ id, ts: 1, requestId: `r${id}`, url, method: 'GET', status: 200, encodedDataLength: 0, durationMs: 1 })

const routes = (): StubRoutes => ({
	'GET /status': STATUS_REPLY,
	'POST /eval': (call) => {
		const expression = String(call.body.expression)
		if (expression === 'boom') return { payload: { ok: true, result: null, type: 'object', exception: { text: 'Uncaught Error: boom' } } }
		return { payload: { ok: true, result: expression, type: 'string', exception: null } }
	},
	'POST /dom/click': { payload: { ok: true, clicked: 1, matches: 1 } },
})

const defer = useCleanup()

const open = async (extra: StubRoutes = {}): Promise<{ stub: StubWatcher; cli: ReturnType<typeof createCli> }> => {
	const stub = await startStubWatcher({ ...routes(), ...extra }, 'app')
	defer(() => stub.close())
	// ARGUS_NO_HINTS keeps eval hints out of stderr assertions.
	return { stub, cli: createCli({ env: argusEnv(stub.home, { ARGUS_NO_HINTS: '1' }), cwd: stub.home }) }
}

describe('argus run -e', () => {
	test('runs each -e as one step, in order, in one process', async () => {
		const { stub, cli } = await open()
		const result = await cli.run(['run', 'app', '-e', 'click --selector "#go"', '-e', 'eval "1+1"'])
		expect(result.stdout).toContain('✓ 1 click --selector "#go"')
		expect(result.stdout).toContain('✓ 2 eval "1+1"')
		expect(stub.calls.map((call) => call.path).filter((p) => p !== '/status')).toEqual(['/dom/click', '/eval'])
	})

	test('--json reports every step with its canonical cmd; stops at the first failure unless --keep-going', async () => {
		const { cli } = await open()
		const stopped = await cli.exec(['run', 'app', '-e', 'js ok', '-e', 'eval boom', '-e', 'eval after', '--json'])
		expect(stopped.code).toBe(1)
		const doc = JSON.parse(stopped.stdout) as { ok: boolean; steps: Array<{ step: number; cmd: string; ok: boolean }> }
		expect(doc.ok).toBe(false)
		expect(doc.steps.map(({ step, cmd, ok }) => ({ step, cmd, ok }))).toEqual([
			{ step: 1, cmd: 'eval', ok: true },
			{ step: 2, cmd: 'eval', ok: false },
		])

		const all = await cli.exec(['run', 'app', '-e', 'eval boom', '-e', 'eval after', '--keep-going', '--json'])
		expect((JSON.parse(all.stdout) as { steps: unknown[] }).steps).toHaveLength(2)
	})
})

describe('net lists compact data: URIs', () => {
	test('human and JSON rows show the header and size, not the payload', async () => {
		const { cli } = await open({ 'GET /net': { payload: { ok: true, requests: [netRequest(1, DATA_URI), netRequest(2, 'http://localhost:3000/api')] } } })
		const human = await cli.run(['net', 'app'])
		expect(human.stdout).toBe('GET 200 1ms 0b data:image/png;base64,…(1498b)\nGET 200 1ms 0b http://localhost:3000/api\n')

		const json = await cli.json<Array<{ url: string }>>(['net', 'app', '--json'])
		expect(json.map((request) => request.url)).toEqual(['data:image/png;base64,…(1498b)', 'http://localhost:3000/api'])
	})
})

describe('argus list', () => {
	test('prints one compact row per watcher on stdout; details stay behind --verbose', async () => {
		const { cli } = await open()
		const compact = await cli.run(['list'])
		expect(compact.stdout).toMatch(/^app · attached · A page title that is quite long, longer… · \d+s\n$/)

		const verbose = await cli.run(['list', '--verbose'])
		expect(verbose.stdout).toContain('127.0.0.1:')
		expect(verbose.stderr).toContain('Watchers')

		const json = await cli.json<{ watchers: Array<{ id: string; cwd?: string }> }>(['list', '--json'])
		expect(json.watchers[0]).toMatchObject({ id: 'app' })
	})
})
