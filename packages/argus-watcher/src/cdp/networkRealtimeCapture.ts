import type { NetWebSocketFrameDirection, NetWebSocketFramePreview } from '@vforsh/argus-core'
import type { RealtimeNetBuffer } from '../buffer/RealtimeNetBuffer.js'
import type { CdpSessionHandle } from './connection.js'
import { captureHeaders, redactUrl } from './redaction.js'

export type RealtimeInflightRequest = {
	requestId: string
	url: string
	method: string
	documentUrl: string | null
	frameId: string | null
	resourceType: string | null
	status: number | null
	statusText: string | null
	mimeType: string | null
	encodedDataLength: number | null
	errorText: string | null
}

export const registerRealtimeNetworkCapture = (options: {
	session: CdpSessionHandle
	buffer: RealtimeNetBuffer | null | undefined
	getInflight: (requestId: string) => RealtimeInflightRequest | null
}): void => {
	options.session.onEvent('Network.eventSourceMessageReceived', (params) => {
		const payload = params as { requestId?: string; eventId?: string; eventName?: string; data?: string }
		if (!payload.requestId) {
			return
		}
		const entry = options.getInflight(payload.requestId)
		if (entry) {
			openSseRequest(options.buffer, entry)
		}
		options.buffer?.recordSseEvent(payload.requestId, {
			eventId: normalizeString(payload.eventId),
			eventName: normalizeString(payload.eventName),
			dataPreview: typeof payload.data === 'string' ? truncatePayload(payload.data) : null,
		})
	})

	options.session.onEvent('Network.webSocketCreated', (params) => {
		const payload = params as { requestId?: string; url?: string; initiator?: { url?: unknown } }
		if (!payload.requestId) {
			return
		}
		options.buffer?.upsertWebSocket(payload.requestId, {
			url: sanitizeOptionalUrl(payload.url ?? null) ?? '',
			documentUrl: typeof payload.initiator?.url === 'string' ? sanitizeOptionalUrl(payload.initiator.url) : null,
			createdAt: Date.now(),
			state: 'created',
		})
	})

	options.session.onEvent('Network.webSocketWillSendHandshakeRequest', (params) => {
		const payload = params as {
			requestId?: string
			wallTime?: number
			request?: { headers?: Record<string, unknown> }
		}
		if (!payload.requestId) {
			return
		}
		options.buffer?.upsertWebSocket(payload.requestId, {
			createdAt: toWallTimeMs(payload.wallTime) ?? Date.now(),
			requestHeaders: captureHeaders(payload.request?.headers),
		})
	})

	options.session.onEvent('Network.webSocketHandshakeResponseReceived', (params) => {
		const payload = params as {
			requestId?: string
			response?: { status?: number; statusText?: string; headers?: Record<string, unknown> }
		}
		if (!payload.requestId) {
			return
		}
		options.buffer?.upsertWebSocket(payload.requestId, {
			state: 'open',
			openedAt: Date.now(),
			status: pickNumber(payload.response?.status),
			statusText: normalizeString(payload.response?.statusText),
			responseHeaders: captureHeaders(payload.response?.headers),
		})
	})

	options.session.onEvent('Network.webSocketFrameSent', (params) => {
		addWebSocketFrame(options.buffer, params, 'sent')
	})

	options.session.onEvent('Network.webSocketFrameReceived', (params) => {
		addWebSocketFrame(options.buffer, params, 'received')
	})

	options.session.onEvent('Network.webSocketFrameError', (params) => {
		const payload = params as { requestId?: string; errorMessage?: string }
		if (!payload.requestId) {
			return
		}
		options.buffer?.upsertWebSocket(payload.requestId, {
			state: 'error',
			errorText: normalizeString(payload.errorMessage),
		})
	})

	options.session.onEvent('Network.webSocketClosed', (params) => {
		const payload = params as { requestId?: string; code?: number; reason?: string }
		if (!payload.requestId) {
			return
		}
		options.buffer?.upsertWebSocket(payload.requestId, {
			state: 'closed',
			closedAt: Date.now(),
			closeCode: pickNumber(payload.code),
			closeReason: normalizeString(payload.reason),
		})
	})
}

export const openSseRequest = (buffer: RealtimeNetBuffer | null | undefined, entry: RealtimeInflightRequest): void => {
	if (!isSseRequest(entry)) {
		return
	}
	buffer?.upsertSse(entry.requestId, {
		url: sanitizeUrl(entry.url),
		method: entry.method,
		documentUrl: sanitizeOptionalUrl(entry.documentUrl),
		frameId: entry.frameId,
		status: entry.status,
		statusText: entry.statusText,
		mimeType: entry.mimeType,
		state: 'open',
		openedAt: Date.now(),
	})
}

export const finalizeSseRequest = (buffer: RealtimeNetBuffer | null | undefined, entry: RealtimeInflightRequest): void => {
	if (!isSseRequest(entry)) {
		return
	}
	buffer?.upsertSse(entry.requestId, {
		url: sanitizeUrl(entry.url),
		method: entry.method,
		documentUrl: sanitizeOptionalUrl(entry.documentUrl),
		frameId: entry.frameId,
		status: entry.status,
		statusText: entry.statusText,
		mimeType: entry.mimeType,
		state: entry.errorText ? 'error' : 'closed',
		closedAt: Date.now(),
		encodedDataLength: entry.encodedDataLength,
		errorText: entry.errorText,
	})
}

const addWebSocketFrame = (buffer: RealtimeNetBuffer | null | undefined, params: unknown, direction: NetWebSocketFrameDirection): void => {
	const payload = params as {
		requestId?: string
		response?: { opcode?: number; mask?: boolean; payloadData?: string }
	}
	if (!payload.requestId) {
		return
	}
	buffer?.addWebSocketFrame(payload.requestId, buildFramePreview(payload.response, direction))
}

const isSseRequest = (entry: Pick<RealtimeInflightRequest, 'resourceType' | 'mimeType'>): boolean => {
	if (entry.resourceType?.toLowerCase() === 'eventsource') {
		return true
	}
	return entry.mimeType?.toLowerCase().startsWith('text/event-stream') === true
}

const buildFramePreview = (
	frame: { opcode?: number; mask?: boolean; payloadData?: string } | undefined,
	direction: NetWebSocketFrameDirection,
): NetWebSocketFramePreview => {
	const payload = frame?.payloadData ?? ''
	const opcode = pickNumber(frame?.opcode)
	return {
		ts: Date.now(),
		direction,
		opcode,
		mask: typeof frame?.mask === 'boolean' ? frame.mask : null,
		payloadLength: Buffer.byteLength(payload),
		preview: payload.length > 0 ? truncatePayload(payload) : null,
		base64Encoded: opcode === 2,
		error: null,
	}
}

const sanitizeUrl = (value: string): string => redactUrl(value)

const sanitizeOptionalUrl = (value: string | null): string | null => (value ? sanitizeUrl(value) : null)

const truncatePayload = (value: string): string => {
	const limit = 500
	return value.length > limit ? `${value.slice(0, limit)}...` : value
}

const toWallTimeMs = (value: unknown): number | null => {
	const seconds = pickNumber(value)
	return seconds != null ? Math.round(seconds * 1000) : null
}

const pickNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

const normalizeString = (value: unknown): string | null => {
	if (typeof value !== 'string') {
		return null
	}
	const trimmed = value.trim()
	return trimmed || null
}
