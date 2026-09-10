import { afterEach, describe, expect, test } from 'bun:test'
import path from 'node:path'
import { startSession, type SessionHarness } from './helpers/session.js'
import { startStubWatcher, type StubRoutes, type StubWatcher } from './helpers/stubWatcher.js'

const BIN_PATH = path.resolve('packages/argus/dist/bin.js')

let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
	await cleanup?.()
	cleanup = undefined
})

const open = async (): Promise<{ session: SessionHarness; stub: StubWatcher }> => {
	let state: 'shown' | 'default' = 'shown'
	let policy: 'foreground' | 'background' = 'background'
	const routes: StubRoutes = {
		'GET /status': { payload: { ok: true, attached: false, protocolVersion: 2, watcherVersion: '0.0.0-test' } },
		'GET /visibility': () => ({ payload: { ok: true, attached: false, state, policy } }),
		'POST /visibility': (call) => {
			if (call.body.policy !== undefined) {
				policy = call.body.policy as typeof policy
			}
			state = call.body.action === 'show' ? 'shown' : 'default'
			return { payload: { ok: true, attached: false, state, policy } }
		},
	}

	const stub = await startStubWatcher(routes, 'app')
	const cwd = path.dirname(stub.registryPath)
	const env = { ...process.env, ARGUS_HOME: cwd }
	const session = startSession(BIN_PATH, ['app'], { env, cwd })
	cleanup = async () => {
		await session.close(5_000)
		await stub.close()
	}
	const ready = await session.next()
	expect(ready).toMatchObject({ type: 'ready', watcher: { id: 'app' } })
	return { session, stub }
}

describe('visibility over the persistent session transport', () => {
	test('dispatches read-only status and policy-aware actions as JSONL responses', async () => {
		const { session, stub } = await open()

		session.send({ id: 'read', cmd: 'page visibility' })
		session.send({ id: 'hide', cmd: 'page hide' })
		session.send({ id: 'show', cmd: 'page show', args: { policy: 'foreground', activate: false } })

		expect(await session.next()).toMatchObject({
			id: 'read',
			ok: true,
			result: { ok: true, attached: false, state: 'shown', policy: 'background' },
		})
		expect(await session.next()).toMatchObject({
			id: 'hide',
			ok: true,
			result: { ok: true, attached: false, state: 'default', policy: 'background' },
		})
		expect(await session.next()).toMatchObject({
			id: 'show',
			ok: true,
			result: { ok: true, attached: false, state: 'shown', policy: 'foreground' },
		})

		expect(stub.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
			'GET /visibility',
			'POST /visibility',
			'GET /visibility',
			'POST /visibility',
		])
		expect(stub.calls[1]?.body).toEqual({ action: 'hide' })
		expect(stub.calls[3]?.body).toEqual({ action: 'show', policy: 'foreground', activate: false })
	})
	test('old watcher support failure never dispatches a visibility mutation', async () => {
		const { session, stub } = await open()
		stub.setRoutes({
			'GET /visibility': { status: 404, payload: { ok: false, error: { code: 'not_found', message: 'Not found' } } },
			'POST /visibility': { payload: { ok: true, attached: true, state: 'shown' } },
		})
		session.send({ id: 'background', cmd: 'page show', args: { policy: 'background' } })
		const response = await session.next()
		expect(response).toMatchObject({ id: 'background', ok: false })
		expect(JSON.stringify(response)).toMatch(/restart/i)
		expect(stub.calls.map((call) => call.method)).toEqual(['GET'])
	})
})
