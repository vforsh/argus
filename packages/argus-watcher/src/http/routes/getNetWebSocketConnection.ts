import type { NetWebSocketResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { clampNumber, normalizeQueryValue, respondJson } from '../httpUtils.js'

export const handle: RouteHandler = (_req, res, url, ctx) => {
	if (!ctx.realtimeNetBuffer) {
		return respondJson(res, { ok: false, error: { code: 'net_disabled', message: 'Network capture is disabled for this watcher' } }, 400)
	}

	const id = clampNumber(url.searchParams.get('id'), undefined, 1)
	const requestId = normalizeQueryValue(url.searchParams.get('requestId'))
	if (id == null && !requestId) {
		return respondJson(res, { ok: false, error: { code: 'invalid_net_request', message: 'Missing WebSocket connection id' } }, 400)
	}

	emitRequest(ctx, res, 'net/ws/connection', { id, requestId: requestId ?? undefined })

	const connection = id != null ? ctx.realtimeNetBuffer.getWebSocketById(id) : ctx.realtimeNetBuffer.getWebSocketByRequestId(requestId!)
	if (!connection) {
		return respondJson(res, { ok: false, error: { code: 'net_request_not_found', message: 'WebSocket connection not found' } }, 404)
	}

	const response: NetWebSocketResponse = { ok: true, connection }
	respondJson(res, response)
}
