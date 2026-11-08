import type { NetSseSummary, NetWebSocketDetail, NetWebSocketFrame, NetWebSocketFramePreview, NetWebSocketSummary } from '@vforsh/argus-core'
import { matchesNetFilters, type NetFilters } from '../net/filtering.js'
import { WebSocketFrameLog, type WebSocketFrameFilters, type WebSocketFrameInput } from './WebSocketFrameLog.js'

const RECENT_FRAME_LIMIT = 20
const RECENT_FRAME_PREVIEW_CHARS = 500

/** Connection record without its frames; `recentFrames` is derived from the frame log on read. */
export type StoredWebSocket = Omit<NetWebSocketDetail, 'recentFrames'>

/** Frame filters as the route parses them; `socket` is an Argus connection id or a CDP requestId. */
export type WebSocketFrameQuery = Omit<WebSocketFrameFilters, 'connectionId'> & { socket?: string }

/** Bounded store for realtime network records: WebSocket connections, their frames, and SSE streams. */
export class RealtimeNetBuffer {
	private readonly maxSize: number
	private readonly frames: WebSocketFrameLog
	private webSockets: StoredWebSocket[] = []
	private sseStreams: NetSseSummary[] = []
	private nextWebSocketId = 1
	private nextSseId = 1

	constructor(maxSize: number) {
		this.maxSize = maxSize
		this.frames = new WebSocketFrameLog(maxSize)
	}

	upsertWebSocket(requestId: string, patch: WebSocketPatch): StoredWebSocket {
		const existing = this.findWebSocketByRequestId(requestId)
		if (existing) {
			applyWebSocketPatch(existing, patch)
			return existing
		}

		const createdAt = patch.createdAt ?? Date.now()
		const detail: StoredWebSocket = {
			id: this.nextWebSocketId++,
			ts: Date.now(),
			requestId,
			url: patch.url ?? '',
			documentUrl: patch.documentUrl ?? null,
			frameId: patch.frameId ?? null,
			state: patch.state ?? 'created',
			status: patch.status ?? null,
			statusText: patch.statusText ?? null,
			createdAt,
			openedAt: patch.openedAt ?? null,
			closedAt: patch.closedAt ?? null,
			durationMs: null,
			sentFrames: 0,
			receivedFrames: 0,
			sentBytes: 0,
			receivedBytes: 0,
			closeCode: patch.closeCode ?? null,
			closeReason: patch.closeReason ?? null,
			errorText: patch.errorText ?? null,
			requestHeaders: patch.requestHeaders,
			responseHeaders: patch.responseHeaders,
		}
		applyWebSocketPatch(detail, patch)
		this.webSockets.push(detail)
		this.trimWebSockets()
		return detail
	}

	/**
	 * Count a frame against its socket and append it to the frame log.
	 *
	 * A frame for an unknown socket means it opened before capture started (attach to a live tab, or after
	 * `net clear`): CDP never replays `webSocketCreated`, so the socket is recorded as open with an unknown URL
	 * instead of silently dropping its traffic.
	 */
	addWebSocketFrame(requestId: string, frame: Omit<WebSocketFrameInput, 'connectionId' | 'requestId' | 'url'>): StoredWebSocket {
		const stored = this.findWebSocketByRequestId(requestId) ?? this.upsertWebSocket(requestId, { state: 'open' })
		if (frame.direction === 'sent') {
			stored.sentFrames += 1
			stored.sentBytes += frame.payloadLength
		} else {
			stored.receivedFrames += 1
			stored.receivedBytes += frame.payloadLength
		}
		stored.ts = Date.now()
		this.frames.add({ ...frame, connectionId: stored.id, requestId, url: stored.url })
		return stored
	}

	listWebSocketsAfter(after: number, filters: NetFilters, limit: number): NetWebSocketSummary[] {
		return this.webSockets
			.filter((connection) => connection.id > after && matchesNetFilters(toFilterableRequest(connection, 'WebSocket'), filters))
			.slice(0, limit)
			.map(toWebSocketSummary)
	}

	/**
	 * List frames after a frame-id cursor.
	 *
	 * `socket` filters by the frame's own ids, so a socket whose record was evicted stays readable while its frames last.
	 *
	 * @returns `null` when `socket` names neither a known connection nor any retained frame, so the route can answer 404.
	 */
	listWebSocketFramesAfter(after: number, query: WebSocketFrameQuery, limit: number): NetWebSocketFrame[] | null {
		const { socket, ...filters } = query
		if (socket == null) return this.frames.listAfter(after, filters, limit)
		const socketFilter = /^\d+$/.test(socket) ? { connectionId: Number(socket) } : { requestId: socket }
		const known = this.webSockets.some((connection) => connection.id === socketFilter.connectionId || connection.requestId === socketFilter.requestId)
		if (!known && !this.frames.some(socketFilter)) return null
		return this.frames.listAfter(after, { ...filters, ...socketFilter }, limit)
	}

	/** Newest frame id ever captured (0 before the first), ignoring filters. */
	get latestWebSocketFrameId(): number {
		return this.frames.latestId
	}

	getWebSocketById(id: number): NetWebSocketDetail | null {
		return this.withRecentFrames(this.webSockets.find((connection) => connection.id === id) ?? null)
	}

	getWebSocketByRequestId(requestId: string): NetWebSocketDetail | null {
		return this.withRecentFrames(this.findWebSocketByRequestId(requestId))
	}

	upsertSse(requestId: string, patch: SsePatch): NetSseSummary {
		const existing = this.sseStreams.find((stream) => stream.requestId === requestId)
		if (existing) {
			const { openedAt: _openedAt, ...nextPatch } = patch
			applySsePatch(existing, nextPatch)
			return existing
		}

		const openedAt = patch.openedAt ?? Date.now()
		const stream: NetSseSummary = {
			id: this.nextSseId++,
			ts: Date.now(),
			requestId,
			url: patch.url ?? '',
			method: patch.method ?? 'GET',
			documentUrl: patch.documentUrl ?? null,
			frameId: patch.frameId ?? null,
			status: patch.status ?? null,
			statusText: patch.statusText ?? null,
			mimeType: patch.mimeType ?? null,
			state: patch.state ?? 'open',
			openedAt,
			closedAt: patch.closedAt ?? null,
			durationMs: null,
			encodedDataLength: patch.encodedDataLength ?? null,
			eventCount: 0,
			lastEventId: null,
			lastEventName: null,
			lastDataPreview: null,
			errorText: patch.errorText ?? null,
		}
		applySsePatch(stream, patch)
		this.sseStreams.push(stream)
		this.trimSse()
		return stream
	}

	recordSseEvent(requestId: string, event: { eventId: string | null; eventName: string | null; dataPreview: string | null }): void {
		const stream = this.sseStreams.find((candidate) => candidate.requestId === requestId)
		if (!stream) {
			return
		}
		stream.eventCount += 1
		stream.lastEventId = event.eventId
		stream.lastEventName = event.eventName
		stream.lastDataPreview = event.dataPreview
		stream.ts = Date.now()
	}

	listSseAfter(after: number, filters: NetFilters, limit: number): NetSseSummary[] {
		return this.sseStreams
			.filter((stream) => stream.id > after && matchesNetFilters(toFilterableRequest(stream, 'EventSource'), filters))
			.slice(0, limit)
			.map((stream) => stream)
	}

	/**
	 * Drop frames, finished sockets, and SSE streams. Open sockets stay: they are still live, and forgetting
	 * them would turn their next frame into an unknown-URL socket.
	 */
	clear(): number {
		const live = this.webSockets.filter((connection) => connection.state === 'created' || connection.state === 'open')
		const cleared = this.webSockets.length - live.length + this.sseStreams.length + this.frames.clear()
		this.webSockets = live
		this.sseStreams = []
		return cleared
	}

	private withRecentFrames(connection: StoredWebSocket | null): NetWebSocketDetail | null {
		if (!connection) return null
		const recentFrames = this.frames.recentForConnection(connection.id, RECENT_FRAME_LIMIT).map(toFramePreview)
		return { ...connection, recentFrames }
	}

	private findWebSocketByRequestId(requestId: string): StoredWebSocket | null {
		return this.webSockets.find((connection) => connection.requestId === requestId) ?? null
	}

	private trimWebSockets(): void {
		if (this.webSockets.length > this.maxSize) {
			this.webSockets = this.webSockets.slice(this.webSockets.length - this.maxSize)
		}
	}

	private trimSse(): void {
		if (this.sseStreams.length > this.maxSize) {
			this.sseStreams = this.sseStreams.slice(this.sseStreams.length - this.maxSize)
		}
	}
}

export type WebSocketPatch = Partial<
	Pick<
		StoredWebSocket,
		| 'url'
		| 'documentUrl'
		| 'frameId'
		| 'state'
		| 'status'
		| 'statusText'
		| 'createdAt'
		| 'openedAt'
		| 'closedAt'
		| 'closeCode'
		| 'closeReason'
		| 'errorText'
		| 'requestHeaders'
		| 'responseHeaders'
	>
>

type SsePatch = Partial<
	Pick<
		NetSseSummary,
		| 'url'
		| 'method'
		| 'documentUrl'
		| 'frameId'
		| 'status'
		| 'statusText'
		| 'mimeType'
		| 'state'
		| 'openedAt'
		| 'closedAt'
		| 'encodedDataLength'
		| 'eventCount'
		| 'lastEventId'
		| 'lastEventName'
		| 'lastDataPreview'
		| 'errorText'
	>
>

const applyWebSocketPatch = (detail: StoredWebSocket, patch: WebSocketPatch): void => {
	// A frame error already ended the socket; its later `webSocketClosed` must not downgrade it to a clean close.
	if (detail.state === 'error' && patch.state === 'closed') {
		patch = { ...patch, state: 'error' }
	}
	for (const [key, value] of Object.entries(patch)) {
		if (value !== undefined) {
			;(detail as Record<string, unknown>)[key] = value
		}
	}
	detail.ts = Date.now()
	detail.durationMs = detail.closedAt != null ? Math.max(0, detail.closedAt - detail.createdAt) : null
}

const toWebSocketSummary = ({
	requestHeaders: _requestHeaders,
	responseHeaders: _responseHeaders,
	...summary
}: StoredWebSocket): NetWebSocketSummary => summary

const toFramePreview = (frame: NetWebSocketFrame): NetWebSocketFramePreview => ({
	ts: frame.ts,
	direction: frame.direction,
	opcode: frame.opcode,
	mask: frame.mask,
	payloadLength: frame.payloadLength,
	preview: previewPayload(frame.payload),
	base64Encoded: frame.base64Encoded,
	error: null,
})

const previewPayload = (payload: string): string | null => {
	if (payload.length === 0) return null
	return payload.length > RECENT_FRAME_PREVIEW_CHARS ? `${payload.slice(0, RECENT_FRAME_PREVIEW_CHARS)}...` : payload
}

const applySsePatch = (stream: NetSseSummary, patch: SsePatch): void => {
	for (const [key, value] of Object.entries(patch)) {
		if (value !== undefined) {
			;(stream as Record<string, unknown>)[key] = value
		}
	}
	stream.ts = Date.now()
	stream.durationMs = stream.closedAt != null ? Math.max(0, stream.closedAt - stream.openedAt) : null
}

const toFilterableRequest = (
	record: Pick<NetWebSocketSummary | NetSseSummary, 'id' | 'ts' | 'requestId' | 'url' | 'documentUrl' | 'frameId' | 'status' | 'durationMs'> & {
		mimeType?: string | null
		method?: string
		encodedDataLength?: number | null
		errorText?: string | null
	},
	resourceType: string,
) => ({
	id: record.id,
	ts: record.ts,
	requestId: record.requestId,
	url: record.url,
	method: record.method ?? 'GET',
	documentUrl: record.documentUrl,
	requestHeaders: undefined,
	resourceType,
	mimeType: record.mimeType ?? null,
	frameId: record.frameId,
	status: record.status,
	encodedDataLength: record.encodedDataLength ?? null,
	errorText: record.errorText ?? null,
	durationMs: record.durationMs,
})
