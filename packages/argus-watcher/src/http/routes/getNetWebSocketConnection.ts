import type { NetWebSocketResponse } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'
import { emitRequest } from './types.js'
import { respondNetDisabled } from './netFilters.js'
import { clampNumber, normalizeQueryValue, respondJson } from '../httpUtils.js'

export const route = defineJsonRoute<undefined, NetWebSocketResponse>({
	method: 'GET',
	path: '/net/ws/connection',
	handle: ({ res, url, ctx }) => {
		if (!ctx.realtimeNetBuffer) {
			return respondNetDisabled(res)
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

		return { ok: true, connection }
	},
})
