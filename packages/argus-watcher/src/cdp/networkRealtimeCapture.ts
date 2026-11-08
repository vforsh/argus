import type { NetWebSocketFrameDirection, NetworkRequestDetail } from '@vforsh/argus-core'
import type { NetBuffer } from '../buffer/NetBuffer.js'
import type { RealtimeNetBuffer, StoredWebSocket, WebSocketPatch } from '../buffer/RealtimeNetBuffer.js'
import type { CdpSessionHandle } from './connection.js'
import { captureHeaders, redactOptionalUrl, redactUrl } from './redaction.js'
import { normalizeString, pickNumber } from './cdpValues.js'

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

/**
 * Subscribe to SSE and WebSocket events. Works the same for CDP and extension watchers: the extension forwards
 * every `Network.*` event of the tab and its child sessions as `cdp_event`.
 */
export const registerRealtimeNetworkCapture = (options: {
	session: CdpSessionHandle
	buffer: RealtimeNetBuffer | null | undefined
	netBuffer: NetBuffer
	getInflight: (requestId: string) => RealtimeInflightRequest | null
}): void => {
	const realtime = options.buffer
	if (!realtime) {
		return
	}

	const updateWebSocket = (requestId: string | undefined, patch: WebSocketPatch): void => {
		if (requestId) syncWebSocketNetRow(options.netBuffer, realtime.upsertWebSocket(requestId, patch))
	}

	const addFrame = (params: unknown, direction: NetWebSocketFrameDirection): void => {
		const payload = params as { requestId?: string; response?: { opcode?: number; mask?: boolean; payloadData?: string } }
		if (payload.requestId) {
			syncWebSocketNetRow(options.netBuffer, realtime.addWebSocketFrame(payload.requestId, buildFrame(payload.response, direction)))
		}
	}

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
		updateWebSocket(payload.requestId, {
			url: redactOptionalUrl(payload.url ?? null) ?? '',
			documentUrl: typeof payload.initiator?.url === 'string' ? redactOptionalUrl(payload.initiator.url) : null,
			createdAt: Date.now(),
			state: 'created',
		})
	})

	options.session.onEvent('Network.webSocketWillSendHandshakeRequest', (params) => {
		const payload = params as { requestId?: string; wallTime?: number; request?: { headers?: Record<string, unknown> } }
		updateWebSocket(payload.requestId, {
			createdAt: toWallTimeMs(payload.wallTime) ?? Date.now(),
			requestHeaders: captureHeaders(payload.request?.headers),
		})
	})

	options.session.onEvent('Network.webSocketHandshakeResponseReceived', (params) => {
		const payload = params as {
			requestId?: string
			response?: { status?: number; statusText?: string; headers?: Record<string, unknown> }
		}
		updateWebSocket(payload.requestId, {
			state: 'open',
			openedAt: Date.now(),
			status: pickNumber(payload.response?.status),
			statusText: normalizeString(payload.response?.statusText),
			responseHeaders: captureHeaders(payload.response?.headers),
		})
	})

	options.session.onEvent('Network.webSocketFrameSent', (params) => addFrame(params, 'sent'))
	options.session.onEvent('Network.webSocketFrameReceived', (params) => addFrame(params, 'received'))

	options.session.onEvent('Network.webSocketFrameError', (params) => {
		const payload = params as { requestId?: string; errorMessage?: string }
		updateWebSocket(payload.requestId, { state: 'error', errorText: normalizeString(payload.errorMessage) })
	})

	options.session.onEvent('Network.webSocketClosed', (params) => {
		const payload = params as { requestId?: string; code?: number; reason?: string }
		updateWebSocket(payload.requestId, {
			state: 'closed',
			closedAt: Date.now(),
			closeCode: pickNumber(payload.code),
			closeReason: normalizeString(payload.reason),
		})
	})
}

/**
 * Mirror a socket into `/net` as a `WebSocket` row and keep it current.
 *
 * Chrome never sends `requestWillBeSent`/`loadingFinished` for sockets, so without this `argus net` showed no
 * trace of them and agents concluded Argus does not capture WebSocket traffic. The row is inserted once and
 * patched in place; an evicted row is re-added with a new id on the socket's next event.
 */
const syncWebSocketNetRow = (netBuffer: NetBuffer, connection: StoredWebSocket): void => {
	// `ts` follows the socket like a finished request's does: its close time, else its latest event. HAR derives the
	// start as `ts - durationMs`, and `net --since` must keep a long-lived socket that is still talking.
	const live = {
		ts: connection.closedAt ?? connection.ts,
		url: connection.url,
		documentUrl: connection.documentUrl,
		status: connection.status,
		encodedDataLength: connection.sentBytes + connection.receivedBytes,
		errorText: connection.errorText,
		durationMs: connection.durationMs,
		webSocket: {
			connectionId: connection.id,
			state: connection.state,
			sentFrames: connection.sentFrames,
			receivedFrames: connection.receivedFrames,
		},
	}
	// Handshake fields arrive after the row exists (`webSocketCreated` inserts it), so they are patched in too.
	const handshake = {
		requestHeaders: connection.requestHeaders,
		responseHeaders: connection.responseHeaders,
		statusText: connection.statusText,
	}
	if (netBuffer.patchByRequestId(connection.requestId, live, handshake)) {
		return
	}

	const summary = {
		requestId: connection.requestId,
		method: 'GET',
		resourceType: 'WebSocket',
		mimeType: null,
		frameId: connection.frameId,
		...live,
	}
	const detail: Omit<NetworkRequestDetail, 'id'> = {
		...summary,
		...handshake,
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
		body: { request: false, response: false },
	}
	netBuffer.add({ summary, detail })
}

export const openSseRequest = (buffer: RealtimeNetBuffer | null | undefined, entry: RealtimeInflightRequest): void => {
	if (!isSseRequest(entry)) {
		return
	}
	buffer?.upsertSse(entry.requestId, {
		url: redactUrl(entry.url),
		method: entry.method,
		documentUrl: redactOptionalUrl(entry.documentUrl),
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
		url: redactUrl(entry.url),
		method: entry.method,
		documentUrl: redactOptionalUrl(entry.documentUrl),
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

const isSseRequest = (entry: Pick<RealtimeInflightRequest, 'resourceType' | 'mimeType'>): boolean => {
	if (entry.resourceType?.toLowerCase() === 'eventsource') {
		return true
	}
	return entry.mimeType?.toLowerCase().startsWith('text/event-stream') === true
}

/** CDP payloads: text frames as-is, binary frames (opcode 2) as base64. */
const buildFrame = (frame: { opcode?: number; mask?: boolean; payloadData?: string } | undefined, direction: NetWebSocketFrameDirection) => {
	const payload = frame?.payloadData ?? ''
	const opcode = pickNumber(frame?.opcode)
	const base64Encoded = opcode === 2
	return {
		ts: Date.now(),
		direction,
		opcode,
		mask: typeof frame?.mask === 'boolean' ? frame.mask : null,
		payloadLength: base64Encoded ? Buffer.from(payload, 'base64').length : Buffer.byteLength(payload),
		payload,
		base64Encoded,
	}
}

const truncatePayload = (value: string): string => {
	const limit = 500
	return value.length > limit ? `${value.slice(0, limit)}...` : value
}

const toWallTimeMs = (value: unknown): number | null => {
	const seconds = pickNumber(value)
	return seconds != null ? Math.round(seconds * 1000) : null
}

