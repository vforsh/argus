import type { NetWebSocketsResponse } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'
import { emitRequest } from './types.js'
import { readNetFiltersFromUrl, respondNetDisabled, toNetRequestEventQuery } from './netFilters.js'

export const route = defineJsonRoute<undefined, NetWebSocketsResponse>({
	method: 'GET',
	path: '/net/ws',
	handle: ({ res, url, ctx }) => {
		if (!ctx.realtimeNetBuffer) {
			return respondNetDisabled(res)
		}

		const filters = readNetFiltersFromUrl(url, ctx, res)
		if (!filters) {
			return
		}

		emitRequest(ctx, res, 'net/ws', toNetRequestEventQuery(filters))

		const connections = ctx.realtimeNetBuffer.listWebSocketsAfter(filters.after, filters, filters.limit)
		const nextAfter = connections.length > 0 ? (connections[connections.length - 1]?.id ?? filters.after) : filters.after
		return { ok: true, connections, nextAfter }
	},
})
