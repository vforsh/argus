import type { NetWebSocketResponse } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'
import { emitRequest } from './types.js'
import { respondNetDisabled } from './netFilters.js'
import { parseNetRequestLookup } from './netRequestLookup.js'
import { respondApiError } from '../httpUtils.js'

export const route = defineJsonRoute<undefined, NetWebSocketResponse>({
	method: 'GET',
	path: '/net/ws/connection',
	handle: ({ res, url, ctx }) => {
		if (!ctx.realtimeNetBuffer) {
			return respondNetDisabled(res)
		}

		const lookup = parseNetRequestLookup(url.searchParams)
		if (!lookup) {
			return respondApiError(res, 400, 'invalid_net_request', 'Missing WebSocket connection id')
		}

		emitRequest(ctx, res, 'net/ws/connection', { id: lookup.id, requestId: lookup.requestId })

		const connection =
			lookup.id != null ? ctx.realtimeNetBuffer.getWebSocketById(lookup.id) : ctx.realtimeNetBuffer.getWebSocketByRequestId(lookup.requestId!)
		if (!connection) {
			return respondApiError(res, 404, 'net_request_not_found', 'WebSocket connection not found')
		}

		return { ok: true, connection }
	},
})
