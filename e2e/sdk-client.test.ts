/**
 * SDK surface added for external verification runners: the routes that were missing from
 * `@vforsh/argus-client`, `evalValue`/`evalUntil`, and the watcher-bound handle.
 *
 * These run against an in-process stub of the watcher HTTP API (see `helpers/stubWatcher.ts`),
 * so they cover registry lookup, request shape, and error mapping without Chrome.
 *
 * Manual verification that cannot run headless — the extension transport:
 *   1. Attach the Argus extension to a page and note the watcher id (`argus list`).
 *   2. `argus eval <id> '({zebra:1,apple:2,mango:3})' --json`
 *      → keys come back **alphabetically sorted**: Chrome's `chrome.debugger` serialization
 *        reorders them at every nesting level. A direct CDP watcher preserves insertion order.
 *   3. Through the SDK, `client.evalValue(id, '({zebra:1,apple:2,mango:3})')`
 *      → keys come back in **insertion order**, byte-identical to the CDP transport, because
 *        `jsonValue` mode serializes inside the page and the string crosses the relay opaquely.
 *   4. Confirm a >=1MB payload survives intact (no truncation or preview) on both transports.
 *
 * A watcher started before `jsonValue` existed ignores the flag; the SDK detects that and
 * raises an actionable "restart the watcher" error rather than degrading silently.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { createArgusClient } from '../packages/argus-client/src/index.js'
import { ArgusEvalError } from '../packages/argus-client/src/eval/ArgusEvalError.js'
import { evalJsonResponse, startStubWatcher, type StubRoutes, type StubWatcher } from './helpers/stubWatcher.js'

let stub: StubWatcher | undefined

afterEach(async () => {
	await stub?.close()
	stub = undefined
})

const withStub = async (routes: StubRoutes) => {
	stub = await startStubWatcher(routes)
	const client = createArgusClient({ registryPath: stub.registryPath })
	return { client, page: client.watcher(stub.watcherId), stub }
}

describe('evalValue', () => {
	test('requests jsonValue mode and unwraps the envelope', async () => {
		const { page, stub } = await withStub({ 'POST /eval': evalJsonResponse({ zebra: 1, apple: 2, nested: { yy: 1, aa: 2 } }) })

		const value = await page.evalValue<Record<string, unknown>>('({zebra:1,apple:2,nested:{yy:1,aa:2}})')

		expect(stub.calls[0]?.body.jsonValue).toBe(true)
		expect(stub.calls[0]?.body.returnByValue).toBe(true)
		// Insertion order is the whole point of jsonValue mode.
		expect(Object.keys(value)).toEqual(['zebra', 'apple', 'nested'])
		expect(Object.keys(value.nested as object)).toEqual(['yy', 'aa'])
	})

	test('passes the expression through untouched so REPL semantics survive', async () => {
		const { page, stub } = await withStub({ 'POST /eval': evalJsonResponse(42, 'number') })

		await page.evalValue('const q = 41; q + 1')

		// Statement lists and top-level await only work if the SDK does not wrap the source.
		expect(stub.calls[0]?.body.expression).toBe('const q = 41; q + 1')
	})

	test('round-trips a genuine undefined', async () => {
		const { page } = await withStub({ 'POST /eval': { payload: { ok: true, result: '{}', type: 'undefined', exception: null } } })

		expect(await page.evalValue('undefined')).toBeUndefined()
	})

	test('returns the raw value and omits the flag when jsonValue is false', async () => {
		const { page, stub } = await withStub({ 'POST /eval': { payload: { ok: true, result: { raw: true }, type: 'object', exception: null } } })

		expect(await page.evalValue<{ raw: boolean }>('({raw:true})', { jsonValue: false })).toEqual({ raw: true })
		expect(stub.calls[0]?.body.jsonValue).toBe(false)
	})

	test('throws ArgusEvalError preferring the page description over bare "Uncaught"', async () => {
		const { page } = await withStub({
			'POST /eval': {
				payload: {
					ok: true,
					result: null,
					type: 'object',
					exception: { text: 'Uncaught', details: { description: 'Error: boom\n    at <anonymous>:1:7' } },
				},
			},
		})

		const error = (await page.evalValue('throw new Error("boom")').catch((e: unknown) => e)) as ArgusEvalError
		expect(error).toBeInstanceOf(ArgusEvalError)
		expect(error.message).toContain('Error: boom')
	})

	test('detects a watcher that predates the jsonValue flag', async () => {
		// Old watchers ignore the unknown flag and return a structured value instead of a string.
		const { page } = await withStub({ 'POST /eval': { payload: { ok: true, result: { zebra: 1 }, type: 'object', exception: null } } })

		await expect(page.evalValue('({zebra:1})')).rejects.toThrow(/predates the flag|Restart the watcher/)
	})

	test('rejects an empty expression before touching the network', async () => {
		const { page, stub } = await withStub({})

		await expect(page.evalValue('   ')).rejects.toThrow(/expression is required/)
		expect(stub.calls).toHaveLength(0)
	})
})

describe('eval stays a raw envelope', () => {
	test('reports page exceptions instead of throwing', async () => {
		const { client, stub } = await withStub({
			'POST /eval': { payload: { ok: true, result: null, type: 'object', exception: { text: 'Uncaught', details: null } } },
		})

		const result = await client.eval(stub.watcherId, { expression: 'throw new Error("x")' })

		expect(result.exception?.text).toBe('Uncaught')
		expect(stub.calls[0]?.body.jsonValue).toBeUndefined()
	})
})

describe('evalUntil', () => {
	test('polls until the value is truthy and reports the matching iteration', async () => {
		let calls = 0
		const { page } = await withStub({
			'POST /eval': () => {
				calls += 1
				return evalJsonResponse(calls >= 3, 'boolean')
			},
		})

		const result = await page.evalUntil('window.ready', { intervalMs: 5 })

		expect(result.value).toBe(true)
		expect(result.iteration).toBe(3)
	})

	test('honors a custom predicate', async () => {
		let calls = 0
		const { page } = await withStub({
			'POST /eval': () => {
				calls += 1
				return evalJsonResponse({ n: calls })
			},
		})

		const result = await page.evalUntil('({n:count})', { intervalMs: 5, predicate: (value) => (value as { n: number }).n >= 4 })

		expect(result.iteration).toBe(4)
	})

	test('throws when the total timeout expires', async () => {
		const { page } = await withStub({ 'POST /eval': evalJsonResponse(false, 'boolean') })

		await expect(page.evalUntil('false', { intervalMs: 10, totalTimeoutMs: 60 })).rejects.toThrow(/timed out after 60ms/)
	})

	test('throws when the poll count is exhausted', async () => {
		const { page } = await withStub({ 'POST /eval': evalJsonResponse(false, 'boolean') })

		await expect(page.evalUntil('false', { intervalMs: 5, count: 2 })).rejects.toThrow(/exhausted 2 polls/)
	})

	test('stops promptly when the signal aborts', async () => {
		const { page } = await withStub({ 'POST /eval': evalJsonResponse(false, 'boolean') })
		const controller = new AbortController()
		setTimeout(() => controller.abort(), 40)

		await expect(page.evalUntil('false', { intervalMs: 10_000, totalTimeoutMs: 60_000, signal: controller.signal })).rejects.toThrow(/aborted/)
	})

	test('surfaces a predicate that throws', async () => {
		const { page } = await withStub({ 'POST /eval': evalJsonResponse(1, 'number') })

		await expect(
			page.evalUntil('1', {
				intervalMs: 5,
				predicate: () => {
					throw new Error('bad predicate')
				},
			}),
		).rejects.toThrow(/predicate threw: bad predicate/)
	})

	test('propagates page exceptions without polling on', async () => {
		const { page, stub } = await withStub({
			'POST /eval': { payload: { ok: true, result: null, type: 'object', exception: { text: 'Uncaught', details: null } } },
		})

		await expect(page.evalUntil('boom', { intervalMs: 5 })).rejects.toBeInstanceOf(ArgusEvalError)
		expect(stub.calls).toHaveLength(1)
	})
})

describe('page routes', () => {
	test('domClick posts the target options', async () => {
		const { page, stub } = await withStub({ 'POST /dom/click': { payload: { ok: true, matches: 2, clicked: 2 } } })

		expect(await page.domClick({ selector: '.row', all: true })).toEqual({ matches: 2, clicked: 2 })
		expect(stub.calls[0]?.path).toBe('/dom/click')
		expect(stub.calls[0]?.body).toMatchObject({ selector: '.row', all: true })
	})

	test('domClick requires a target', async () => {
		const { page, stub } = await withStub({})

		await expect(page.domClick({})).rejects.toThrow(/selector, ref, or x,y/)
		expect(stub.calls).toHaveLength(0)
	})

	test('visibility posts the action and returns the lock state', async () => {
		const { page, stub } = await withStub({ 'POST /visibility': { payload: { ok: true, attached: true, state: 'shown' } } })

		expect(await page.visibility({ action: 'show' })).toEqual({ attached: true, state: 'shown' })
		expect(stub.calls[0]?.body).toEqual({ action: 'show' })
	})

	test('visibility rejects an unknown action', async () => {
		const { page } = await withStub({})

		// @ts-expect-error deliberately invalid action
		await expect(page.visibility({ action: 'toggle' })).rejects.toThrow(/'show' or 'hide'/)
	})

	test('reload forwards ignoreCache', async () => {
		const { page, stub } = await withStub({ 'POST /reload': { payload: { ok: true } } })

		await page.reload({ ignoreCache: true })
		expect(stub.calls[0]?.body).toEqual({ ignoreCache: true })
	})

	test('netClear reports how many buffered requests were dropped', async () => {
		const { page, stub } = await withStub({ 'POST /net/clear': { payload: { ok: true, cleared: 7 } } })

		expect(await page.netClear()).toEqual({ cleared: 7 })
		expect(stub.calls[0]?.method).toBe('POST')
	})
})

describe('recording', () => {
	const stopPayload = {
		ok: true,
		recordId: 'rec-1',
		sessionName: 'session',
		outFile: '/tmp/out.mp4',
		format: 'mp4',
		fps: 30,
		clipped: false,
		frameCount: 90,
		durationMs: 3000,
	}

	test('record captures for a fixed duration', async () => {
		const { page, stub } = await withStub({ 'POST /record': { payload: stopPayload } })

		const result = await page.record({ durationMs: 3000, outFile: '/tmp/out.mp4' })

		expect(result).toMatchObject({ outFile: '/tmp/out.mp4', frameCount: 90, format: 'mp4' })
		expect(stub.calls[0]?.body).toMatchObject({ durationMs: 3000 })
	})

	test('record rejects a non-positive duration', async () => {
		const { page, stub } = await withStub({})

		await expect(page.record({ durationMs: 0 })).rejects.toThrow(/durationMs must be greater than 0/)
		expect(stub.calls).toHaveLength(0)
	})

	test('record rejects selector and clip together', async () => {
		const { page } = await withStub({})

		await expect(page.record({ durationMs: 100, selector: 'canvas', clip: { x: 0, y: 0, width: 10, height: 10 } })).rejects.toThrow(
			/mutually exclusive/,
		)
	})

	test('recordStart then recordStop finalizes the file', async () => {
		const { page, stub } = await withStub({
			'POST /record/start': {
				payload: { ok: true, recordId: 'rec-1', sessionName: 'session', outFile: '/tmp/out.webm', format: 'webm', fps: 15, clipped: true },
			},
			'POST /record/stop': { payload: { ...stopPayload, outFile: '/tmp/out.webm', format: 'webm', fps: 15, clipped: true } },
		})

		const started = await page.recordStart({ outFile: '/tmp/out.webm', fps: 15, selector: 'canvas' })
		expect(started).toMatchObject({ recordId: 'rec-1', format: 'webm', clipped: true })

		const stopped = await page.recordStop({ recordId: started.recordId })
		expect(stopped).toMatchObject({ outFile: '/tmp/out.webm', frameCount: 90 })
		expect(stub.calls[1]?.body).toEqual({ recordId: 'rec-1' })
	})
})

describe('registry pruning on failure', () => {
	test('keeps the watcher when it answers with an error status', async () => {
		const { page, stub } = await withStub({
			'POST /record': { status: 400, payload: { ok: false, error: { message: 'fps must be between 1 and 60' } } },
		})

		await expect(page.record({ durationMs: 100, fps: 999 })).rejects.toThrow(/fps must be between 1 and 60/)

		// The watcher answered, so it is alive: evicting it would break every later call.
		const registry = await stub.readRegistry()
		expect(registry.watchers[stub.watcherId]).toBeDefined()
	})

	test('still usable for the next call after a watcher-side error', async () => {
		const { page } = await withStub({
			'POST /record': { status: 400, payload: { ok: false, error: { message: 'nope' } } },
			'POST /eval': evalJsonResponse('alive', 'string'),
		})

		await expect(page.record({ durationMs: 100 })).rejects.toThrow(/nope/)
		expect(await page.evalValue<string>('"alive"')).toBe('alive')
	})

	test('evicts the watcher when the transport itself fails', async () => {
		const { page, stub } = await withStub({ 'POST /eval': evalJsonResponse(1, 'number') })
		await stub.stopServer()

		await expect(page.evalValue('1')).rejects.toThrow(/failed to reach watcher/)

		const registry = await stub.readRegistry()
		expect(registry.watchers[stub.watcherId]).toBeUndefined()
	})
})

describe('watcher-bound handle', () => {
	test('binds the id for every watcher-scoped method', async () => {
		const { client, stub } = await withStub({ 'POST /net/clear': { payload: { ok: true, cleared: 1 } } })
		const bound = client.watcher(stub.watcherId)

		expect(await bound.netClear()).toEqual({ cleared: 1 })
	})

	test('list stays off the bound handle', async () => {
		const { client, stub } = await withStub({})

		expect('list' in client.watcher(stub.watcherId)).toBe(false)
	})
})
