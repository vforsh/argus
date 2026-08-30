import type { NetWebSocketResponse } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'
import { emitRequest } from './types.js'
import { respondNetDisabled } from './netFilters.js'
import { parseNetRequestLookup } from './netRequestLookup.js'
import { respondJson } from '../httpUtils.js'

export const route = defineJsonRoute<undefined, NetWebSocketResponse>({
	method: 'GET',
	path: '/net/ws/connection',
	handle: ({ res, url, ctx }) => {
		if (!ctx.realtimeNetBuffer) {
			return respondNetDisabled(res)
		}

		const lookup = parseNetRequestLookup(url.searchParams)
		if (!lookup) {
			return respondJson(res, { ok: false, error: { code: 'invalid_net_request', message: 'Missing WebSocket connection id' } }, 400)
		}

		emitRequest(ctx, res, 'net/ws/connection', { id: lookup.id, requestId: lookup.requestId })

		const connection =
			lookup.id != null ? ctx.realtimeNetBuffer.getWebSocketById(lookup.id) : ctx.realtimeNetBuffer.getWebSocketByRequestId(lookup.requestId!)
		if (!connection) {
			return respondJson(res, { ok: false, error: { code: 'net_request_not_found', message: 'WebSocket connection not found' } }, 404)
		}

		return { ok: true, connection }
	},
})
