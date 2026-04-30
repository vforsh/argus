import type { NetWebSocketsResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { parseNetRequestFilters, toNetRequestEventQuery } from './netFilters.js'
import { clampNumber, respondJson } from '../httpUtils.js'

export const handle: RouteHandler = (_req, res, url, ctx) => {
	if (!ctx.realtimeNetBuffer) {
		return respondJson(res, { ok: false, error: { code: 'net_disabled', message: 'Network capture is disabled for this watcher' } }, 400)
	}

	const filters = parseNetRequestFilters(url.searchParams, {
		after: clampNumber(url.searchParams.get('after'), 0),
		limit: clampNumber(url.searchParams.get('limit'), 500, 1, 5000),
		sinceTs: clampNumber(url.searchParams.get('sinceTs'), undefined),
		context: ctx.getNetFilterContext?.() ?? null,
	})
	if (filters.error || !filters.value) {
		return respondJson(res, { ok: false, error: { code: 'invalid_net_filter', message: filters.error ?? 'Invalid network filter' } }, 400)
	}

	emitRequest(ctx, res, 'net/ws', toNetRequestEventQuery(filters.value))

	const connections = ctx.realtimeNetBuffer.listWebSocketsAfter(filters.value.after, filters.value, filters.value.limit)
	const nextAfter = connections.length > 0 ? (connections[connections.length - 1]?.id ?? filters.value.after) : filters.value.after
	const response: NetWebSocketsResponse = { ok: true, connections, nextAfter }
	respondJson(res, response)
}
