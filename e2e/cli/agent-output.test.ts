import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { useCleanup } from '../helpers/cleanup.js'
import { argusEnv, createCli } from '../helpers/cli.js'
import { startStubWatcher, type StubRoutes, type StubWatcher } from '../helpers/stubWatcher.js'
import { TIMEOUTS } from '../helpers/timeouts.js'

setDefaultTimeout(TIMEOUTS.process)

/** Agent-facing output contracts against a stub watcher: `run -e`. */

const STATUS_REPLY = { payload: { ok: true, attached: true, protocolVersion: 2, watcherVersion: '0.0.0-test' } }

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
	// ARGUS_NO_HINTS keeps the cadence hint out of stderr assertions.
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
