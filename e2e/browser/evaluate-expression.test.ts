import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { chromium, type Browser, type CDPSession, type Page } from 'playwright'
import {
	evaluateExpression,
	type CdpEvent,
	type CdpEventHandler,
	type CdpEventPayload,
	type CdpResult,
	type CdpSendOptions,
	type CdpSessionHandle,
} from '@vforsh/argus-watcher/internal'
import { createFakeCdpSession } from '../helpers/fakeCdpSession.js'
import { TIMEOUTS } from '../helpers/timeouts.js'

setDefaultTimeout(TIMEOUTS.browser)

type CannedResult = { result?: unknown; exceptionDetails?: unknown }

/** Session that replies to each CDP method with a canned `Runtime.*` payload. */
const cannedSession = (canned: Record<string, CannedResult>) => createFakeCdpSession({ respond: (method) => canned[method] })

/**
 * Watcher-side `jsonValue` mode: serialize the result inside the page so the JSON string,
 * not a structured object, crosses the transport.
 *
 * This exists because Chrome's `chrome.debugger` serialization (the extension relay) sorts
 * object keys alphabetically at every nesting level while a direct CDP watcher preserves
 * insertion order — so the same page state yields different bytes per transport.
 */
describe('evaluateExpression with jsonValue', () => {
	test('serializes an object inside the page and returns the JSON string', async () => {
		const json = '{"v":{"zebra":1,"apple":2,"nested":{"yy":1,"aa":2}}}'
		const session = cannedSession({
			'Runtime.evaluate': { result: { type: 'object', objectId: 'obj-1' } },
			'Runtime.callFunctionOn': { result: { type: 'string', value: json } },
		})

		const response = await evaluateExpression(session, { expression: '({zebra:1})', jsonValue: true })

		expect(response.result).toBe(json)
		expect(response.type).toBe('object')
		expect(response.exception).toBeNull()

		const call = session.calls.find((entry) => entry.method === 'Runtime.callFunctionOn')
		expect(call?.params.objectId).toBe('obj-1')
		expect(call?.params.returnByValue).toBe(true)
		expect(String(call?.params.functionDeclaration)).toContain('JSON.stringify')
	})

	test('serializes primitives locally without a second round-trip', async () => {
		const session = cannedSession({ 'Runtime.evaluate': { result: { type: 'number', value: 42 } } })

		const response = await evaluateExpression(session, { expression: '42', jsonValue: true })

		expect(response.result).toBe('{"v":42}')
		expect(session.methods).not.toContain('Runtime.callFunctionOn')
	})

	test('encodes a genuine undefined as the empty envelope', async () => {
		const session = cannedSession({ 'Runtime.evaluate': { result: { type: 'undefined' } } })

		const response = await evaluateExpression(session, { expression: 'undefined', jsonValue: true })

		expect(response.result).toBe('{}')
	})

	test('reports a page exception when serialization throws', async () => {
		// Circular structures and throwing `toJSON` hooks surface here.
		const session = cannedSession({
			'Runtime.evaluate': { result: { type: 'object', objectId: 'obj-1' } },
			'Runtime.callFunctionOn': {
				exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: Converting circular structure to JSON' } },
			},
		})

		const response = await evaluateExpression(session, { expression: 'circular', jsonValue: true })

		expect(response.exception?.text).toBe('Uncaught')
		expect(response.result).toBeNull()
	})

	test('leaves the default path untouched when jsonValue is off', async () => {
		const session = cannedSession({ 'Runtime.evaluate': { result: { type: 'number', value: 7 } } })

		const response = await evaluateExpression(session, { expression: '7' })

		expect(response.result).toBe(7)
	})

	test('does not alter how the expression is evaluated', async () => {
		const session = cannedSession({ 'Runtime.evaluate': { result: { type: 'number', value: 1 } } })

		await evaluateExpression(session, { expression: 'const q = 41; q + 1', jsonValue: true, replMode: true })

		// Statement lists and top-level await depend on REPL mode and an unmodified source.
		const evaluate = session.calls.find((entry) => entry.method === 'Runtime.evaluate')
		expect(evaluate?.params.expression).toBe('const q = 41; q + 1')
		expect(evaluate?.params.replMode).toBe(true)
	})
})

describe('watcher eval argument isolation', () => {
	let browser: Browser
	let page: Page
	let session: CdpSessionHandle

	beforeAll(async () => {
		browser = await chromium.launch()
		page = await browser.newPage()
		await page.goto('data:text/html,<title>eval-args-isolation</title>')
		const cdp = await page.context().newCDPSession(page)
		session = createSessionHandle(cdp)
	})

	afterAll(async () => {
		await browser.close()
	})

	test('keeps concurrent args correlated on one watcher session', async () => {
		const requests = Array.from({ length: 40 }, (_, index) => {
			const itemId = index % 2 === 0 ? '19000060271' : '89270200013'
			return evaluateExpression(session, {
				expression: `await new Promise((resolve) => setTimeout(resolve, ${index % 5})); ({ requested: args.itemId, returned: args.itemId })`,
				args: { itemId },
			})
		})

		const responses = await Promise.all(requests)
		for (const [index, response] of responses.entries()) {
			const expected = index % 2 === 0 ? '19000060271' : '89270200013'
			expect(response.exception).toBeNull()
			expect(response.result).toEqual({ requested: expected, returned: expected })
		}
	})

	test('never mutates or cleans up a page-owned global on success or exception', async () => {
		await page.evaluate(() => {
			Object.defineProperty(globalThis, 'args', { configurable: true, value: Object.freeze({ owner: 'page' }) })
		})

		const success = await evaluateExpression(session, { expression: 'args.request', args: { request: 'success' } })
		const failure = await evaluateExpression(session, { expression: 'throw new Error(args.request)', args: { request: 'failure' } })

		expect(success.result).toBe('success')
		expect(failure.exception?.text).toContain('Uncaught')
		expect(await page.evaluate(() => (globalThis as typeof globalThis & { args: unknown }).args)).toEqual({ owner: 'page' })
	})

	test('leaves page state untouched when awaiting a result times out', async () => {
		await expect(
			evaluateExpression(session, {
				expression: 'new Promise(() => args.request)',
				args: { request: 'timeout' },
				timeoutMs: 25,
			}),
		).rejects.toThrow('timed out after 25ms')

		expect(await page.evaluate(() => (globalThis as typeof globalThis & { args: unknown }).args)).toEqual({ owner: 'page' })
	})
})

/**
 * Adapt a Playwright `CDPSession` to the watcher's session interface.
 *
 * Playwright types its protocol map independently, so the command and event payloads are cast
 * across the boundary; the test asserts on behavior, not on those shapes.
 */
const createSessionHandle = (cdp: CDPSession): CdpSessionHandle => ({
	isAttached: () => true,
	sendAndWait: (method, params, options) => withTimeout(cdp.send(method as never, params as never), options) as Promise<CdpResult<typeof method>>,
	onEvent: (method, handler) => onCdpEvent(cdp, method, handler as CdpEventHandler),
	getTargetContext: () => ({ kind: 'page' }),
	getReadyTargetContext: async () => ({ kind: 'page' }),
})

const withTimeout = async <T>(promise: Promise<T>, options?: CdpSendOptions): Promise<T> => {
	if (!options?.timeoutMs) return promise

	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`CDP request timed out after ${options.timeoutMs}ms`)), options.timeoutMs)
			}),
		])
	} finally {
		if (timer) clearTimeout(timer)
	}
}

const onCdpEvent = (cdp: CDPSession, method: string, handler: CdpEventHandler): (() => void) => {
	const listener = (params: unknown): void => handler(params as CdpEventPayload<CdpEvent>, { sessionId: null })
	cdp.on(method as never, listener)
	return () => cdp.off(method as never, listener)
}
