import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chromium, type Browser, type CDPSession, type Page } from 'playwright'
import type { CdpEventHandler, CdpSendOptions, CdpSessionHandle } from '../packages/argus-watcher/src/cdp/connection.js'
import type { CdpEvent, CdpEventPayload, CdpResult } from '../packages/argus-watcher/src/cdp/protocol.js'
import { evaluateExpression } from '../packages/argus-watcher/src/cdp/eval.js'

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
