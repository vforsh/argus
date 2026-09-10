import type http from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'bun:test'
import { BACKGROUND_CAPTURE_UNAVAILABLE_MESSAGE } from '../src/cdp/capturePolicy.js'
import { recordRoutes } from '../src/http/routes/postRecord.js'
import { route as screenshotRoute } from '../src/http/routes/postScreenshot.js'
import { route as visibilityRoute } from '../src/http/routes/postVisibility.js'
import { respondCaptureUnavailable } from '../src/http/routes/visualCaptureRoute.js'
import type { RouteContext } from '../src/http/routes/types.js'

describe('visual capture route policy', () => {
	it('returns the existing not_available error with a headless fallback', () => {
		let statusCode: number | undefined
		let body: string | undefined
		const response = {
			setHeader: () => {},
			end: (value: string) => {
				body = value
			},
		} as unknown as http.ServerResponse
		Object.defineProperty(response, 'statusCode', {
			get: () => statusCode,
			set: (value: number) => {
				statusCode = value
			},
		})
		const ctx = {
			visibilityController: { getPolicy: () => 'background' },
		} as unknown as RouteContext

		expect(respondCaptureUnavailable(response, ctx)).toBe(true)
		expect(statusCode).toBe(400)
		expect(JSON.parse(body ?? '')).toEqual({ ok: false, error: { message: BACKGROUND_CAPTURE_UNAVAILABLE_MESSAGE, code: 'not_available' } })
	})

	it('leaves foreground captures available', () => {
		const response = {} as http.ServerResponse
		const ctx = { visibilityController: { getPolicy: () => 'foreground' } } as unknown as RouteContext

		expect(respondCaptureUnavailable(response, ctx)).toBe(false)
	})

	it('blocks the screenshot, timed recording, and recording start routes before their services run', async () => {
		for (const [route, body] of [
			[screenshotRoute, {}],
			[recordRoutes[0], { durationMs: 1 }],
			[recordRoutes[1], {}],
		] as const) {
			let responseBody: string | undefined
			const response = createResponse((body) => {
				responseBody = body
			})
			const request = Readable.from([JSON.stringify(body)]) as unknown as http.IncomingMessage
			const ctx = {
				visibilityController: { getPolicy: () => 'background' },
				screenshotter: {
					capture: async () => {
						throw new Error('screenshot service should not run')
					},
				},
				recorder: {
					capture: async () => {
						throw new Error('record service should not run')
					},
					start: async () => {
						throw new Error('record service should not run')
					},
				},
				onRequest: undefined,
			} as unknown as RouteContext

			await route.handler(request, response, new URL('http://127.0.0.1/'), ctx)
			expect(JSON.parse(responseBody ?? '')).toMatchObject({ ok: false, error: { code: 'not_available' } })
		}
	})

	it('rejects switching to background mode while a recording is active', async () => {
		let responseBody: string | undefined
		let setLockCalled = false
		const response = createResponse((body) => {
			responseBody = body
		})
		const request = Readable.from([JSON.stringify({ action: 'show', policy: 'background' })]) as unknown as http.IncomingMessage
		const ctx = {
			visibilityController: {
				getPolicy: () => 'foreground',
				setLock: async () => {
					setLockCalled = true
				},
			},
			recorder: { status: () => ({}) },
			onRequest: undefined,
		} as unknown as RouteContext

		await visibilityRoute.handler(request, response, new URL('http://127.0.0.1/'), ctx)

		expect(setLockCalled).toBe(false)
		expect((response as unknown as { statusCode?: number }).statusCode).toBe(400)
		expect(JSON.parse(responseBody ?? '')).toMatchObject({
			ok: false,
			error: { code: 'not_available', message: expect.stringContaining('Stop the recording first') },
		})
	})
})

const createResponse = (onEnd: (body: string) => void): http.ServerResponse => {
	const response = {
		req: { socket: { remoteAddress: '127.0.0.1' } },
		setHeader: () => {},
		end: onEnd,
	} as unknown as http.ServerResponse
	return response
}
