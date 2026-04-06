import { describe, expect, it } from 'bun:test'
import type { CdpSessionHandle } from '../src/cdp/connection.js'
import { readNetworkBody } from '../src/cdp/networkBody.js'

describe('network body reader', () => {
	it('targets child sessions when reading request bodies', async () => {
		const calls: Array<{ method: string; params?: Record<string, unknown>; options?: Record<string, unknown> }> = []
		const session = createSessionStub(calls, { postData: '{"ok":true}' })

		const result = await readNetworkBody({
			session,
			request: {
				requestId: 'req-1',
				mimeType: 'application/json',
				requestHeaders: { 'content-type': 'application/json' },
			},
			sessionId: 'frame-session-1',
			part: 'request',
		})

		expect(result).toEqual({
			body: '{"ok":true}',
			base64Encoded: false,
			mimeType: 'application/json',
		})
		expect(calls).toEqual([
			{
				method: 'Network.getRequestPostData',
				params: { requestId: 'req-1' },
				options: { timeoutMs: 5_000, sessionId: 'frame-session-1' },
			},
		])
	})

	it('targets child sessions when reading response bodies', async () => {
		const calls: Array<{ method: string; params?: Record<string, unknown>; options?: Record<string, unknown> }> = []
		const session = createSessionStub(calls, { body: 'eyJvayI6dHJ1ZX0=', base64Encoded: true })

		const result = await readNetworkBody({
			session,
			request: {
				requestId: 'req-2',
				mimeType: 'application/json',
				requestHeaders: undefined,
			},
			sessionId: 'frame-session-2',
			part: 'response',
		})

		expect(result).toEqual({
			body: 'eyJvayI6dHJ1ZX0=',
			base64Encoded: true,
			mimeType: 'application/json',
		})
		expect(calls).toEqual([
			{
				method: 'Network.getResponseBody',
				params: { requestId: 'req-2' },
				options: { timeoutMs: 5_000, sessionId: 'frame-session-2' },
			},
		])
	})
})

const createSessionStub = (
	calls: Array<{ method: string; params?: Record<string, unknown>; options?: Record<string, unknown> }>,
	result: unknown,
): CdpSessionHandle => ({
	isAttached: () => true,
	sendAndWait: async (method, params, options) => {
		calls.push({ method, params, options })
		return result
	},
	onEvent: () => () => {},
})
