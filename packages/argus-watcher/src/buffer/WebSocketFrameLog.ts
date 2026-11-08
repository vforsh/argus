import type { NetWebSocketFrame, NetWebSocketFrameDirection } from '@vforsh/argus-core'
import { CircularBuffer } from './CircularBuffer.js'

/** Filters for {@link WebSocketFrameLog.listAfter}; every set field must match. */
export type WebSocketFrameFilters = {
	connectionId?: number
	requestId?: string
	sinceTs?: number
	/** Substring of the redacted socket URL. */
	grep?: string
	/** Payload regexes; a frame matching any one is kept. */
	match?: RegExp[]
	direction?: NetWebSocketFrameDirection
}

/** A frame as the capture reports it, before the log assigns its id and applies the storage cap. */
export type WebSocketFrameInput = Omit<NetWebSocketFrame, 'id' | 'truncated'>

/** Payload characters kept per frame; longer payloads are stored truncated (`truncated: true`). */
const NET_WS_FRAME_STORED_CHARS = 64 * 1024

/**
 * Payload characters kept across all frames. A chatty socket (game state, market ticks) can push
 * megabytes a minute, so the count cap alone would let the log grow to gigabytes; past this budget
 * the oldest frames go first, the same eviction order as the count cap.
 */
const MAX_STORED_PAYLOAD_CHARS = 16 * 1024 * 1024

/**
 * Bounded, ordered log of WebSocket frames across every socket of a watcher.
 *
 * Ids are monotonic and contiguous (every add gets the next id and eviction only drops the oldest),
 * so `after` cursors index straight into the ring like `NetBuffer` does.
 */
export class WebSocketFrameLog {
	private readonly frames: CircularBuffer<NetWebSocketFrame>
	private readonly maxStoredChars: number
	private storedChars = 0
	private nextId = 1

	constructor(maxFrames: number, maxStoredChars = MAX_STORED_PAYLOAD_CHARS) {
		this.frames = new CircularBuffer(maxFrames)
		this.maxStoredChars = maxStoredChars
	}

	add(input: WebSocketFrameInput): NetWebSocketFrame {
		const truncated = input.payload.length > NET_WS_FRAME_STORED_CHARS
		const frame: NetWebSocketFrame = {
			id: this.nextId++,
			...input,
			payload: truncated ? copyString(input.payload.slice(0, NET_WS_FRAME_STORED_CHARS)) : input.payload,
			truncated,
		}
		this.storedChars += frame.payload.length
		const evicted = this.frames.push(frame)
		if (evicted) this.storedChars -= evicted.payload.length
		while (this.storedChars > this.maxStoredChars && this.frames.length > 1) {
			this.storedChars -= this.frames.shift()!.payload.length
		}
		return frame
	}

	listAfter(after: number, filters: WebSocketFrameFilters, limit: number): NetWebSocketFrame[] {
		const results: NetWebSocketFrame[] = []
		const firstId = this.frames.at(0)?.id ?? this.nextId
		for (let index = Math.max(0, Math.floor(after) - firstId + 1); index < this.frames.length && results.length < limit; index++) {
			const frame = this.frames.at(index)!
			if (matchesFrame(frame, filters)) results.push(frame)
		}
		return results
	}

	/** Id of the newest frame ever added (0 before the first); a follow-from-now cursor. */
	get latestId(): number {
		return this.nextId - 1
	}

	/** Whether any retained frame matches; lets a socket whose record was evicted still be read. */
	some(filters: WebSocketFrameFilters): boolean {
		for (let index = 0; index < this.frames.length; index++) {
			if (matchesFrame(this.frames.at(index)!, filters)) return true
		}
		return false
	}

	/** Newest `count` frames of one socket, oldest first. */
	recentForConnection(connectionId: number, count: number): NetWebSocketFrame[] {
		const results: NetWebSocketFrame[] = []
		for (let index = this.frames.length - 1; index >= 0 && results.length < count; index--) {
			const frame = this.frames.at(index)!
			if (frame.connectionId === connectionId) results.push(frame)
		}
		return results.reverse()
	}

	/** Drop every frame, keeping the id sequence monotonic so live cursors stay valid. */
	clear(): number {
		this.storedChars = 0
		return this.frames.clear()
	}
}

/**
 * Copy a string into its own allocation. JavaScriptCore keeps a sliced prefix pointing into its source, so a stored
 * 64 KiB prefix of a 10 MB frame would pin all 10 MB and the payload budget would bound nothing.
 */
const copyString = (value: string): string => Buffer.from(value, 'utf16le').toString('utf16le')

const matchesFrame = (frame: NetWebSocketFrame, filters: WebSocketFrameFilters): boolean => {
	if (filters.connectionId != null && frame.connectionId !== filters.connectionId) return false
	if (filters.requestId != null && frame.requestId !== filters.requestId) return false
	if (filters.direction && frame.direction !== filters.direction) return false
	if (filters.sinceTs != null && frame.ts < filters.sinceTs) return false
	if (filters.grep && !frame.url.includes(filters.grep)) return false
	if (filters.match && filters.match.length > 0 && !filters.match.some((pattern) => pattern.test(frame.payload))) return false
	return true
}
