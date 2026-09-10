import { afterEach, describe, expect, test } from 'bun:test'
import { createArgusClient } from '@vforsh/argus-client'
import { startStubWatcher, type StubRoutes, type StubWatcher } from './helpers/stubWatcher.js'

type VisibilitySnapshot = {
	ok: true
	attached: boolean
	state: 'shown' | 'default'
	policy: 'foreground' | 'background'
}

let stub: StubWatcher | undefined

afterEach(async () => {
	await stub?.close()
	stub = undefined
})

const withStub = async (routes: StubRoutes) => {
	stub = await startStubWatcher(routes, 'visibility-sdk')
	const client = createArgusClient({ registryPath: stub.registryPath })
	return { page: client.watcher(stub.watcherId), stub }
}

describe('visibility SDK', () => {
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
		const { page, stub } = await withStub({
			'GET /visibility': { status: 404, payload: { ok: false, error: { code: 'not_found', message: 'Not found' } } },
			'POST /visibility': { payload: { ok: true, attached: true, state: 'shown' } },
		})
		await expect(page.visibility(options)).rejects.toThrow(/restart/i)
		expect(stub.calls.map((call) => call.method)).toEqual(['GET'])
	})

	test('requires a valid policy in the support response', async () => {
		const { page, stub } = await withStub({
			'GET /visibility': { payload: { ok: true, attached: true, state: 'default' } },
			'POST /visibility': { payload: { ok: true, attached: true, state: 'shown' } },
		})
		await expect(page.visibility({ action: 'show', policy: 'background' })).rejects.toThrow(/restart/i)
		expect(stub.calls.map((call) => call.method)).toEqual(['GET'])
	})

	test('legacy action-only calls retain old foreground semantics without a support probe', async () => {
		const { page, stub } = await withStub({
			'POST /visibility': { payload: { ok: true, attached: true, state: 'shown' } },
		})
		expect(await page.visibility({ action: 'show' })).toEqual({ attached: true, state: 'shown', policy: 'foreground' })
		expect(stub.calls.map((call) => call.method)).toEqual(['POST'])
	})
})
