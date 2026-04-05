import { describe, expect, it } from 'bun:test'
import type { CdpEventHandler, CdpEventMeta, CdpSessionHandle } from '../src/cdp/connection.js'
import { NetBuffer } from '../src/buffer/NetBuffer.js'
import { createNetworkCapture } from '../src/cdp/networkCapture.js'

describe('network capture', () => {
	it('stores summaries and detailed request records for later inspection', async () => {
		const stub = createSessionStub()
		const buffer = new NetBuffer(10)
		const capture = createNetworkCapture({ session: stub.session, buffer })

		await capture.onAttached()
		expect(stub.calls).toEqual(['Network.enable'])

		stub.emit('Network.requestWillBeSent', {
			requestId: 'req-1',
			timestamp: 1,
			type: 'Fetch',
			documentURL: 'https://example.com/app?access_token=secret',
			frameId: 'frame-1',
			loaderId: 'loader-1',
			initiator: {
				type: 'script',
				url: 'https://example.com/app.js?token=secret',
				lineNumber: 10,
				columnNumber: 4,
				stack: {
					callFrames: [
						{
							functionName: 'loadData',
							url: 'https://example.com/app.js?token=secret',
							lineNumber: 10,
							columnNumber: 4,
						},
					],
				},
			},
			request: {
				url: 'https://example.com/start?access_token=secret',
				method: 'POST',
				headers: {
					Authorization: 'Bearer abcdefghijklmnop',
					'X-Client': 'argus-test',
				},
				initialPriority: 'Low',
			},
		})

		stub.emit('Network.requestWillBeSentExtraInfo', {
			requestId: 'req-1',
			headers: {
				Cookie: 'session=abc; theme=dark',
			},
		})

		stub.emit('Network.requestWillBeSent', {
			requestId: 'req-1',
			timestamp: 1.1,
			request: {
				url: 'https://example.com/final?access_token=secret',
				method: 'POST',
				headers: {
					'X-Client': 'argus-test',
				},
				initialPriority: 'High',
			},
			redirectResponse: {
				url: 'https://example.com/start?access_token=secret',
				status: 302,
				statusText: 'Found',
			},
		})

		stub.emit('Network.responseReceived', {
			requestId: 'req-1',
			type: 'Fetch',
			response: {
				url: 'https://example.com/final?access_token=secret',
				status: 200,
				statusText: 'OK',
				mimeType: 'application/json',
				protocol: 'h2',
				remoteIPAddress: '127.0.0.1',
				remotePort: 443,
				requestHeaders: {
					Authorization: 'Bearer abcdefghijklmnop',
				},
				headers: {
					'content-type': 'application/json',
					'set-cookie': 'session=abc; Path=/',
					'x-trace-id': 'trace-123',
				},
				fromServiceWorker: true,
				serviceWorkerResponseSource: 'cache-storage',
				timing: {
					dnsStart: 5,
					dnsEnd: 10,
					connectStart: 10,
					connectEnd: 20,
					sslStart: 12,
					sslEnd: 18,
					sendStart: 21,
					sendEnd: 22,
					receiveHeadersEnd: 50,
				},
			},
		})

		stub.emit('Network.resourceChangedPriority', {
			requestId: 'req-1',
			newPriority: 'VeryHigh',
		})
		stub.emit('Network.loadingFinished', {
			requestId: 'req-1',
			encodedDataLength: 2048,
			timestamp: 1.2,
		})

		const summary = buffer.listAfter(0, {}, 10)[0]
		expect(summary).toMatchObject({
			requestId: 'req-1',
			url: 'https://example.com/final?access_token=redacted',
			method: 'POST',
			resourceType: 'Fetch',
			status: 200,
			encodedDataLength: 2048,
			durationMs: 100,
		})
		expect(summary?.requestHeaders).toMatchObject({
			authorization: 'Bearer abcd...mnop',
			cookie: 'session=<redacted>; theme=<redacted>',
		})

		const detailById = buffer.getById(summary?.id ?? 0)
		const detailByRequestId = buffer.getByRequestId('req-1')
		expect(detailById).toEqual(detailByRequestId)
		expect(detailById).toMatchObject({
			statusText: 'OK',
			mimeType: 'application/json',
			documentUrl: 'https://example.com/app?access_token=redacted',
			frameId: 'frame-1',
			loaderId: 'loader-1',
			protocol: 'h2',
			remoteAddress: '127.0.0.1',
			remotePort: 443,
			priority: 'VeryHigh',
			fromServiceWorker: true,
			serviceWorkerResponseSource: 'cache-storage',
			redirects: [
				{
					fromUrl: 'https://example.com/start?access_token=redacted',
					toUrl: 'https://example.com/final?access_token=redacted',
					status: 302,
					statusText: 'Found',
				},
			],
			timingPhases: {
				totalMs: 100,
				blockedMs: 5,
				dnsMs: 5,
				connectMs: 10,
				sslMs: 6,
				sendMs: 1,
				waitMs: 28,
				downloadMs: 50,
			},
		})
		expect(detailById?.requestHeaders).toMatchObject({
			authorization: 'Bearer abcd...mnop',
			cookie: 'session=<redacted>; theme=<redacted>',
			'x-client': 'argus-test',
		})
		expect(detailById?.responseHeaders).toMatchObject({
			'content-type': 'application/json',
			'set-cookie': 'session=<redacted>; Path=<redacted>',
			'x-trace-id': 'trace-123',
		})
		expect(detailById?.initiator?.stack).toEqual([
			{
				functionName: 'loadData',
				url: 'https://example.com/app.js?token=redacted',
				lineNumber: 10,
				columnNumber: 4,
			},
		])
	})
})

const createSessionStub = () => {
	const handlers = new Map<string, Set<CdpEventHandler>>()
	const calls: string[] = []

	const session: CdpSessionHandle = {
		isAttached: () => true,
		sendAndWait: async (method) => {
			calls.push(method)
			return {}
		},
		onEvent: (method, handler) => {
			let bucket = handlers.get(method)
			if (!bucket) {
				bucket = new Set()
				handlers.set(method, bucket)
			}
			bucket.add(handler)
			return () => {
				bucket?.delete(handler)
			}
		},
	}

	return {
		calls,
		session,
		emit: (method: string, params: unknown, meta: CdpEventMeta = { sessionId: null }) => {
			for (const handler of handlers.get(method) ?? []) {
				handler(params, meta)
			}
		},
	}
}
