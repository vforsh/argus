import { afterEach, describe, expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { runCommand } from './helpers/process.js'
import { startSession, type SessionHarness } from './helpers/session.js'
import { startStubWatcher, type StubRoutes, type StubWatcher } from './helpers/stubWatcher.js'

const BIN_PATH = path.resolve('packages/argus/dist/bin.js')

const STATUS_REPLY = { payload: { ok: true, attached: true, protocolVersion: 2, watcherVersion: '0.0.0-test' } }

const routes = (): StubRoutes => ({
	'GET /status': STATUS_REPLY,
	'POST /eval': (call) => ({ payload: { ok: true, result: String(call.body.expression), type: 'string', exception: null } }),
	'POST /dom/click': { payload: { ok: true, clicked: 1, matches: 1 } },
})

const open = async (args: string[] = []): Promise<{ stub: StubWatcher; session: SessionHarness; env: NodeJS.ProcessEnv; cwd: string }> => {
	const stub = await startStubWatcher(routes(), 'app')
	const cwd = path.dirname(stub.registryPath)
	const env = { ...process.env, ARGUS_HOME: cwd }
	const session = startSession(BIN_PATH, ['app', ...args], { env, cwd })

	const ready = await session.next()
	expect(ready).toMatchObject({ type: 'ready', watcher: { id: 'app' } })

	open.cleanup.push(async () => {
		await session.close(5_000)
		await stub.close()
	})
	return { stub, session, env, cwd }
}
open.cleanup = [] as (() => Promise<void>)[]

afterEach(async () => {
	for (const cleanup of open.cleanup.splice(0)) {
		await cleanup()
	}
})

describe('argus session', () => {
	test('answers requests with the same payload the one-shot CLI prints', async () => {
		const { session, env, cwd } = await open()

		session.send({ id: 1, cmd: 'eval', args: { expression: 'location.href' } })
		const response = await session.next()

		const oneShot = await runCommand('bun', [BIN_PATH, 'eval', 'app', 'location.href', '--json'], { env, cwd })
		expect(response).toMatchObject({ id: 1, ok: true })
		expect(response.result).toEqual(JSON.parse(oneShot.stdout))
	})

	test('accepts raw argv and named args for the same command', async () => {
		const { session } = await open()

		session.send({ id: 'named', cmd: 'click', args: { selector: 'button.go' } })
		session.send({ id: 'raw', cmd: 'click', argv: ['--selector', 'button.go'] })

		expect(await session.next()).toMatchObject({ id: 'named', ok: true, result: { clicked: 1 } })
		expect(await session.next()).toMatchObject({ id: 'raw', ok: true, result: { clicked: 1 } })
	})

	test('keeps serving after a rejected request', async () => {
		const { session } = await open()

		session.send({ id: 1, cmd: 'no-such-command' })
		session.send({ id: 2, cmd: 'eval', args: { nonsense: true } })
		session.send('{ not json at all')
		session.send({ id: 4, cmd: 'eval', args: { expression: '1 + 1' } })

		expect(await session.next()).toMatchObject({ id: 1, ok: false, error: { code: 'session_unknown_command' } })
		expect(await session.next()).toMatchObject({ id: 2, ok: false, error: { code: 'session_invalid_request' } })
		expect(await session.next()).toMatchObject({ ok: false, error: { code: 'session_invalid_request' } })
		expect(await session.next()).toMatchObject({ id: 4, ok: true })
	})

	test('cuts a request off at its timeout and serves the next one', async () => {
		const { session } = await open(['--request-timeout', '400ms'])

		// A 60-iteration poll far outlives the watchdog, and streams a JSON line per iteration —
		// so this also pins that an abandoned command cannot write into the next request's output.
		session.send({ id: 1, cmd: 'eval', args: { expression: 'Date.now()', interval: '1s', count: 60 } })
		session.send({ id: 2, cmd: 'eval', args: { expression: 'location.href' } })

		expect(await session.next()).toMatchObject({ id: 1, ok: false, error: { code: 'session_request_timeout' } })
		expect(await session.next()).toMatchObject({ id: 2, ok: true })
	})

	test('refuses commands that would take stdin or never return', async () => {
		const { session } = await open()

		session.send({ id: 1, cmd: 'eval', argv: ['--stdin'] })
		session.send({ id: 2, cmd: 'logs tail' })
		session.send({ id: 3, cmd: 'session' })

		for (const id of [1, 2, 3]) {
			expect(await session.next()).toMatchObject({ id, ok: false, error: { code: 'session_command_rejected' } })
		}
	})

	test('exits 0 on quit and on EOF', async () => {
		const quitting = await open()
		quitting.session.send({ id: 'bye', cmd: 'quit' })
		expect(await quitting.session.next()).toMatchObject({ id: 'bye', ok: true })
		expect((await quitting.session.wait()).code).toBe(0)

		const ending = await open()
		expect((await ending.session.close()).code).toBe(0)
	})

	test('exits non-zero once the watcher is gone, unless --reconnect is set', async () => {
		const failFast = await open()
		await failFast.stub.stopServer()
		failFast.session.send({ id: 1, cmd: 'eval', args: { expression: 'location.href' } })

		expect(await failFast.session.next()).toMatchObject({ id: 1, ok: false })
		const exit = await failFast.session.wait()
		expect(exit.code).toBe(1)
		expect(failFast.session.stderr()).toContain('no longer reachable')

		const surviving = await open(['--reconnect'])
		await surviving.stub.stopServer()
		surviving.session.send({ id: 1, cmd: 'eval', args: { expression: 'location.href' } })
		expect(await surviving.session.next()).toMatchObject({ id: 1, ok: false })

		surviving.session.send({ id: 2, cmd: 'ping' })
		expect(await surviving.session.next()).toMatchObject({ id: 2, ok: true, result: { pong: true } })
	})

	test('keeps console chatter off stdout', async () => {
		const stub = await startStubWatcher(routes(), 'app')
		const cwd = path.dirname(stub.registryPath)
		const pluginPath = path.join(cwd, 'noisy-plugin.mjs')
		await writeFile(
			pluginPath,
			`console.log('chatter at load time')
export default {
	apiVersion: 1,
	name: 'noisy',
	commands: ['noisy'],
	register({ program }) {
		program.command('noisy').option('--json', 'json').action(() => {
			console.log('chatter at run time')
			process.stdout.write(JSON.stringify({ ok: true, noisy: true }) + '\\n')
		})
	},
}
`,
			'utf8',
		)

		const env = { ...process.env, ARGUS_HOME: cwd, ARGUS_PLUGINS: pluginPath }
		const session = startSession(BIN_PATH, ['app'], { env, cwd })
		open.cleanup.push(async () => {
			await session.close(5_000)
			await stub.close()
		})

		expect(await session.next()).toMatchObject({ type: 'ready' })
		session.send({ id: 1, cmd: 'noisy' })
		expect(await session.next()).toMatchObject({ id: 1, ok: true, result: { ok: true, noisy: true } })

		const exit = await session.close()
		for (const line of exit.stdout) {
			expect(() => JSON.parse(line)).not.toThrow()
		}
		expect(session.stderr()).toContain('chatter at load time')
		expect(session.stderr()).toContain('chatter at run time')
	})
})
