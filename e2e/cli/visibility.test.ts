/**
 * The old-watcher compatibility contract for `page show`/`hide` safety options, over each transport:
 * a watcher without `GET /visibility` support is refused before any mutation is dispatched.
 */
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { createArgusClient } from '@vforsh/argus-client'
import { useCleanup } from '../helpers/cleanup.js'
import { argusEnv, createCli } from '../helpers/cli.js'
import { BIN_PATH } from '../helpers/paths.js'
import { startSession, type SessionHarness } from '../helpers/session.js'
import { startStubWatcher, type StubReply, type StubRoutes, type StubWatcher } from '../helpers/stubWatcher.js'
import { TIMEOUTS } from '../helpers/timeouts.js'

setDefaultTimeout(TIMEOUTS.process)

/** A pre-policy watcher's mutation reply: no `policy` field. */
const LEGACY_SHOWN_REPLY: StubReply = { payload: { ok: true, attached: true, state: 'shown' } }

/** A watcher that predates `GET /visibility` and would still accept the mutation. */
const OLD_WATCHER_ROUTES: StubRoutes = {
	'GET /visibility': { status: 404, payload: { ok: false, error: { code: 'not_found', message: 'Not found' } } },
	// An older watcher would ignore the unknown options and activate here.
	'POST /visibility': LEGACY_SHOWN_REPLY,
}

const defer = useCleanup()

describe('visibility CLI', () => {
	for (const flags of [['--policy', 'background'], ['--no-activate']]) {
		test(`page show ${flags.join(' ')} refuses an old watcher without activating it`, async () => {
			const stub = await startStubWatcher(OLD_WATCHER_ROUTES, 'visibility-cli')
			defer(() => stub.close())
			const cli = createCli({ env: argusEnv(stub.home, { ARGUS_REGISTRY_PATH: stub.registryPath }) })
			const result = await cli.exec(['page', 'show', stub.watcherId, ...flags, '--json'])
			expect(result.code).not.toBe(0)
			const response = JSON.parse(result.stdout)
			expect(response).toMatchObject({ ok: false, error: { code: 'not_available' } })
			expect(response.error.message).toMatch(/restart/i)
			expect(stub.calls.map((call) => call.method)).toEqual(['GET'])
		})
	}
})

type VisibilitySnapshot = {
	ok: true
	attached: boolean
	state: 'shown' | 'default'
	policy: 'foreground' | 'background'
}

describe('visibility SDK', () => {
	const withStub = async (routes: StubRoutes) => {
		const stub = await startStubWatcher(routes, 'visibility-sdk')
		defer(() => stub.close())
		const client = createArgusClient({ registryPath: stub.registryPath })
		return { page: client.watcher(stub.watcherId), stub }
	}

	test('reads a snapshot without mutation and forwards an explicit background policy', async () => {
		const snapshot: VisibilitySnapshot = { ok: true, attached: false, state: 'shown', policy: 'foreground' }
		const { page, stub } = await withStub({
			'GET /visibility': { payload: snapshot },
			'POST /visibility': (call) => {
				expect(call.body).toEqual({ action: 'show', policy: 'background' })
				return { payload: { ...snapshot, attached: true, policy: 'background' } }
			},
		})

		expect(await page.visibilityStatus()).toEqual({ attached: false, state: 'shown', policy: 'foreground' })
		expect(stub.calls).toHaveLength(1)
		expect(stub.calls[0]).toMatchObject({ method: 'GET', path: '/visibility', body: {} })

		expect(await page.visibility({ action: 'show', policy: 'background' })).toEqual({
			attached: true,
			state: 'shown',
			policy: 'background',
		})
		expect(stub.calls.map((call) => call.method)).toEqual(['GET', 'GET', 'POST'])
	})

	test('omitting policy leaves policy selection to the watcher', async () => {
		const { page, stub } = await withStub({
			'POST /visibility': (call) => {
				expect(call.body).toEqual({ action: 'hide' })
				return { payload: { ok: true, attached: false, state: 'default', policy: 'background' } }
			},
		})

		expect(await page.visibility({ action: 'hide' })).toMatchObject({ state: 'default', policy: 'background' })
		expect(stub.calls).toHaveLength(1)
	})
	test.each([
		{ action: 'show' as const, policy: 'background' as const },
		{ action: 'show' as const, activate: false },
	])('refuses safety options on an old watcher before mutation: %j', async (options) => {
		const { page, stub } = await withStub(OLD_WATCHER_ROUTES)
		await expect(page.visibility(options)).rejects.toThrow(/restart/i)
		expect(stub.calls.map((call) => call.method)).toEqual(['GET'])
	})

	test('requires a valid policy in the support response', async () => {
		const { page, stub } = await withStub({
			'GET /visibility': { payload: { ok: true, attached: true, state: 'default' } },
			'POST /visibility': LEGACY_SHOWN_REPLY,
		})
		await expect(page.visibility({ action: 'show', policy: 'background' })).rejects.toThrow(/restart/i)
		expect(stub.calls.map((call) => call.method)).toEqual(['GET'])
	})

	test('legacy action-only calls retain old foreground semantics without a support probe', async () => {
		const { page, stub } = await withStub({
			'POST /visibility': LEGACY_SHOWN_REPLY,
		})
		expect(await page.visibility({ action: 'show' })).toEqual({ attached: true, state: 'shown', policy: 'foreground' })
		expect(stub.calls.map((call) => call.method)).toEqual(['POST'])
	})
})

describe('visibility over the persistent session transport', () => {
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
		const cwd = stub.home
		const session = startSession(BIN_PATH, ['app'], { env: argusEnv(cwd), cwd })
		defer(async () => {
			await session.close(5_000)
			await stub.close()
		})
		const ready = await session.next()
		expect(ready).toMatchObject({ type: 'ready', watcher: { id: 'app' } })
		return { session, stub }
	}

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
		stub.setRoutes(OLD_WATCHER_ROUTES)
		session.send({ id: 'background', cmd: 'page show', args: { policy: 'background' } })
		const response = await session.next()
		expect(response).toMatchObject({ id: 'background', ok: false })
		expect(JSON.stringify(response)).toMatch(/restart/i)
		expect(stub.calls.map((call) => call.method)).toEqual(['GET'])
	})
})
