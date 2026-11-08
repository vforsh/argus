import type { NetWebSocketFrame, NetWebSocketFramesQuery, NetWebSocketFramesResponse } from '@vforsh/argus-core'
import { NET_WS_FRAME_DIRECTIONS, delay } from '@vforsh/argus-core'
import type { RealtimeNetBuffer, WebSocketFrameQuery } from '../../buffer/RealtimeNetBuffer.js'
import { defineJsonRoute } from './defineRoute.js'
import { emitRequest } from './types.js'
import { nextAfterCursor, respondNetDisabled } from './netFilters.js'
import {
	clampNumber,
	compileMatchPatterns,
	normalizeMatchPatterns,
	normalizeQueryValue,
	optionalNumber,
	respondApiError,
	respondInvalidMatch,
	respondInvalidMatchCase,
	resolveMatchCase,
} from '../httpUtils.js'

const param = (url: URL, key: keyof NetWebSocketFramesQuery): string | null => url.searchParams.get(key)

/**
 * GET /net/ws/frames: captured frames across sockets, oldest first, after a frame-id cursor.
 * With `timeoutMs` it long-polls until a matching frame arrives (`net ws tail`).
 */
export const route = defineJsonRoute<undefined, NetWebSocketFramesResponse>({
	method: 'GET',
	path: '/net/ws/frames',
	handle: async ({ res, url, ctx }) => {
		const buffer = ctx.realtimeNetBuffer
		if (!buffer) {
			return respondNetDisabled(res)
		}

		const direction = normalizeQueryValue(param(url, 'direction'))
		if (direction && !NET_WS_FRAME_DIRECTIONS.includes(direction as never)) {
			return respondApiError(res, 400, 'invalid_net_filter', `Invalid direction: ${direction} (expected sent or received)`)
		}
		const matchCase = resolveMatchCase(param(url, 'matchCase'))
		if (!matchCase) {
			return respondInvalidMatchCase(res)
		}
		const patterns = normalizeMatchPatterns(url.searchParams.getAll('match' satisfies keyof NetWebSocketFramesQuery))
		const compiled = patterns.error ? { error: patterns.error } : compileMatchPatterns(patterns.patterns, matchCase)
		if (compiled.error) {
			return respondInvalidMatch(res, compiled.error)
		}

		const after = clampNumber(param(url, 'after'), 0)
		const limit = clampNumber(param(url, 'limit'), 500, 1, 5000)
		const timeoutMs = optionalNumber(param(url, 'timeoutMs'), 0, 120_000)
		const maxPayloadChars = optionalNumber(param(url, 'maxPayloadChars'), 1)
		const query: WebSocketFrameQuery = {
			socket: normalizeQueryValue(param(url, 'socket')),
			sinceTs: optionalNumber(param(url, 'sinceTs')),
			grep: normalizeQueryValue(param(url, 'grep')),
			match: compiled.match,
			direction: direction as WebSocketFrameQuery['direction'],
		}

		emitRequest(ctx, res, 'net/ws/frames', {
			after,
			limit,
			timeoutMs,
			sinceTs: query.sinceTs,
			socket: query.socket,
			grep: query.grep,
			match: patterns.patterns,
			matchCase,
			direction: query.direction,
			maxPayloadChars,
		})

		const frames = await pollFrames(buffer, after, query, limit, timeoutMs ?? 0)
		if (!frames) {
			return respondApiError(res, 404, 'net_request_not_found', `WebSocket connection not found: ${query.socket}`)
		}
		return {
			ok: true,
			frames: maxPayloadChars == null ? frames : frames.map((frame) => capPayload(frame, Math.floor(maxPayloadChars))),
			nextAfter: nextAfterCursor(frames, after),
			timedOut: frames.length === 0 && timeoutMs != null,
			latestId: buffer.latestWebSocketFrameId,
		}
	},
})

const FRAME_POLL_INTERVAL_MS = 100

/** Same boring polling as `/net/tail`: one caller, and it survives extension reloads without waiter bookkeeping. */
const pollFrames = async (
	buffer: RealtimeNetBuffer,
	after: number,
	query: WebSocketFrameQuery,
	limit: number,
	timeoutMs: number,
): Promise<NetWebSocketFrame[] | null> => {
	const deadline = Date.now() + timeoutMs
	while (true) {
		const frames = buffer.listWebSocketFramesAfter(after, query, limit)
		if (!frames || frames.length > 0) {
			return frames
		}
		const remainingMs = deadline - Date.now()
		if (remainingMs <= 0) {
			return frames
		}
		await delay(Math.min(FRAME_POLL_INTERVAL_MS, remainingMs))
	}
}

const capPayload = (frame: NetWebSocketFrame, maxChars: number): NetWebSocketFrame =>
	frame.payload.length <= maxChars ? frame : { ...frame, payload: frame.payload.slice(0, maxChars), truncated: true }
