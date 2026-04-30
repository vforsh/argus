import type { NetSseSummary, NetWebSocketDetail, NetWebSocketFramePreview, NetWebSocketSummary } from '@vforsh/argus-core'
import { matchesNetFilters, type NetFilters } from '../net/filtering.js'

const RECENT_FRAME_LIMIT = 20

/** Bounded store for realtime network records: WebSocket connections and SSE streams. */
export class RealtimeNetBuffer {
	private readonly maxSize: number
	private webSockets: NetWebSocketDetail[] = []
	private sseStreams: NetSseSummary[] = []
	private nextWebSocketId = 1
	private nextSseId = 1

	constructor(maxSize: number) {
		this.maxSize = maxSize
	}

	upsertWebSocket(requestId: string, patch: WebSocketPatch): NetWebSocketDetail {
		const existing = this.findWebSocketByRequestId(requestId)
		if (existing) {
			applyWebSocketPatch(existing, patch)
			return existing
		}

		const createdAt = patch.createdAt ?? Date.now()
		const detail: NetWebSocketDetail = {
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
			recentFrames: [],
		}
		applyWebSocketPatch(detail, patch)
		this.webSockets.push(detail)
		this.trimWebSockets()
		return detail
	}

	addWebSocketFrame(requestId: string, frame: NetWebSocketFramePreview): void {
		const stored = this.findWebSocketByRequestId(requestId)
		if (!stored) {
			return
		}

		if (frame.direction === 'sent') {
			stored.sentFrames += 1
			stored.sentBytes += frame.payloadLength
		} else {
			stored.receivedFrames += 1
			stored.receivedBytes += frame.payloadLength
		}

		stored.recentFrames.push(frame)
		if (stored.recentFrames.length > RECENT_FRAME_LIMIT) {
			stored.recentFrames = stored.recentFrames.slice(stored.recentFrames.length - RECENT_FRAME_LIMIT)
		}
		stored.ts = Date.now()
	}

	listWebSocketsAfter(after: number, filters: NetFilters, limit: number): NetWebSocketSummary[] {
		return this.webSockets
			.filter((connection) => connection.id > after && matchesNetFilters(toFilterableRequest(connection, 'WebSocket'), filters))
			.slice(0, limit)
			.map(toWebSocketSummary)
	}

	getWebSocketById(id: number): NetWebSocketDetail | null {
		return this.webSockets.find((connection) => connection.id === id) ?? null
	}

	getWebSocketByRequestId(requestId: string): NetWebSocketDetail | null {
		return this.findWebSocketByRequestId(requestId)
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

	clear(): number {
		const cleared = this.webSockets.length + this.sseStreams.length
		this.webSockets = []
		this.sseStreams = []
		return cleared
	}

	private findWebSocketByRequestId(requestId: string): NetWebSocketDetail | null {
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

type WebSocketPatch = Partial<
	Pick<
		NetWebSocketDetail,
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

const applyWebSocketPatch = (detail: NetWebSocketDetail, patch: WebSocketPatch): void => {
	for (const [key, value] of Object.entries(patch)) {
		if (value !== undefined) {
			;(detail as Record<string, unknown>)[key] = value
		}
	}
	detail.ts = Date.now()
	detail.durationMs = detail.closedAt != null ? Math.max(0, detail.closedAt - detail.createdAt) : null
}

const toWebSocketSummary = ({
	recentFrames: _recentFrames,
	requestHeaders: _requestHeaders,
	responseHeaders: _responseHeaders,
	...summary
}: NetWebSocketDetail): NetWebSocketSummary => summary

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
