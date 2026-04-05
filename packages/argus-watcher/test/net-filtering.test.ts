import { describe, expect, it } from 'bun:test'
import type { NetworkRequestDetail, NetworkRequestSummary } from '@vforsh/argus-core'
import { NetBuffer } from '../src/buffer/NetBuffer.js'
import { parseNetRequestFilters } from '../src/http/routes/netFilters.js'

describe('net filters', () => {
	it('matches richer host, method, status, mime, party, and threshold filters', () => {
		const buffer = new NetBuffer(10)
		buffer.add(
			createRecord({
				requestId: 'game-init',
				url: 'https://api.stark.games/game/init',
				method: 'POST',
				resourceType: 'Fetch',
				mimeType: 'application/json',
				frameId: 'frame-game',
				status: 200,
				durationMs: 180,
				encodedDataLength: 2048,
			}),
		)
		buffer.add(
			createRecord({
				requestId: 'analytics',
				url: 'https://mc.vk.com/collect',
				method: 'POST',
				resourceType: 'Fetch',
				mimeType: 'text/plain',
				frameId: 'frame-root',
				status: 200,
				durationMs: 40,
				encodedDataLength: 256,
			}),
		)
		buffer.add(
			createRecord({
				requestId: 'game-fail',
				url: 'https://api.stark.games/game/fail',
				method: 'POST',
				resourceType: 'Fetch',
				mimeType: 'application/json',
				frameId: 'frame-game',
				status: 503,
				errorText: 'Failed',
				durationMs: 75,
				encodedDataLength: 128,
			}),
		)

		const matching = buffer.list(
			{
				hosts: ['stark.games'],
				methods: ['POST'],
				statuses: ['2xx'],
				resourceTypes: ['fetch'],
				mimeTypes: ['application/json'],
				party: 'first',
				partyHost: 'stark.games',
				frameId: 'frame-game',
				minDurationMs: 150,
				minTransferBytes: 1024,
			},
			10,
		)

		expect(matching).toHaveLength(1)
		expect(matching[0]?.requestId).toBe('game-init')

		const failed = buffer.list({ failedOnly: true }, 10)
		expect(failed.map((entry) => entry.requestId)).toEqual(['game-fail'])
	})

	it('defaults to tab scope and still resolves first-party host from the selected target when requested', () => {
		const parsed = parseNetRequestFilters(new URLSearchParams('party=first'), {
			after: 0,
			limit: 50,
			context: {
				sourceMode: 'extension',
				selectedFrameId: 'frame-game',
				topFrameId: 'frame-root',
				selectedTargetUrl: 'https://ts-elka2025-vk.stark.games/embed/index.html',
				pageUrl: 'https://vk.com/app123',
			},
		})

		expect(parsed.error).toBeUndefined()
		expect(parsed.value).toMatchObject({
			scope: 'tab',
			frameId: undefined,
			party: 'first',
			partyHost: 'vk.com',
		})
	})

	it('resolves page scope to the top frame and rejects conflicting scope/frame filters', () => {
		const pageScoped = parseNetRequestFilters(new URLSearchParams('scope=page'), {
			after: 0,
			limit: 50,
			context: {
				sourceMode: 'extension',
				selectedFrameId: 'frame-game',
				topFrameId: 'frame-root',
				selectedTargetUrl: 'https://game.stark.games/embed',
				pageUrl: 'https://vk.com/app123',
			},
		})
		expect(pageScoped.value?.frameId).toBe('frame-root')

		const invalid = parseNetRequestFilters(new URLSearchParams('scope=selected&frame=frame-root'), {
			after: 0,
			limit: 50,
		})
		expect(invalid.error).toContain('Cannot combine scope and frame filters')
	})

	it('keeps selected-scope matching stable when a reload swaps the iframe frame id', () => {
		const buffer = new NetBuffer(10)
		buffer.add(
			createRecord({
				requestId: 'reloaded-frame',
				url: 'https://resources.stark.games/boot.json',
				documentUrl: 'https://game.stark.games/embed/index.html?token=new',
				method: 'GET',
				resourceType: 'Fetch',
				mimeType: 'application/json',
				frameId: 'frame-new',
				status: 200,
			}),
		)

		const parsed = parseNetRequestFilters(new URLSearchParams('scope=selected'), {
			after: 0,
			limit: 50,
			context: {
				sourceMode: 'extension',
				selectedFrameId: 'frame-old',
				topFrameId: 'frame-root',
				selectedTargetUrl: 'https://game.stark.games/embed/index.html?token=old',
				pageUrl: 'https://vk.com/app123',
			},
		})

		expect(parsed.error).toBeUndefined()
		const matching = buffer.list(parsed.value ?? {}, 10)
		expect(matching).toHaveLength(1)
		expect(matching[0]?.requestId).toBe('reloaded-frame')
	})

	it('resolves selected scope explicitly when requested', () => {
		const parsed = parseNetRequestFilters(new URLSearchParams('scope=selected'), {
			after: 0,
			limit: 50,
			context: {
				sourceMode: 'extension',
				selectedFrameId: 'frame-game',
				topFrameId: 'frame-root',
				selectedTargetUrl: 'https://game.stark.games/embed/index.html?token=old',
				pageUrl: 'https://vk.com/app123',
			},
		})

		expect(parsed.error).toBeUndefined()
		expect(parsed.value).toMatchObject({
			scope: 'selected',
			frameId: 'frame-game',
			documentUrlKey: 'https://game.stark.games/embed/index.html',
		})
	})
})

const createRecord = (
	overrides: Partial<NetworkRequestSummary> & Pick<NetworkRequestSummary, 'requestId' | 'url' | 'method'>,
): { summary: Omit<NetworkRequestSummary, 'id'>; detail: Omit<NetworkRequestDetail, 'id'> } => {
	const summary: Omit<NetworkRequestSummary, 'id'> = {
		ts: 1,
		requestId: overrides.requestId,
		url: overrides.url,
		method: overrides.method,
		documentUrl: overrides.documentUrl ?? overrides.url,
		requestHeaders: overrides.requestHeaders,
		resourceType: overrides.resourceType ?? 'Fetch',
		mimeType: overrides.mimeType ?? 'application/json',
		frameId: overrides.frameId ?? null,
		status: overrides.status ?? 200,
		encodedDataLength: overrides.encodedDataLength ?? 0,
		errorText: overrides.errorText ?? null,
		durationMs: overrides.durationMs ?? 0,
	}

	return {
		summary,
		detail: {
			...summary,
			responseHeaders: undefined,
			statusText: null,
			loaderId: null,
			initiator: null,
			redirects: [],
			servedFromCache: false,
			fromDiskCache: false,
			fromPrefetchCache: false,
			fromServiceWorker: false,
			serviceWorkerResponseSource: null,
			remoteAddress: null,
			remotePort: null,
			protocol: null,
			priority: null,
			timingPhases: null,
		},
	}
}
