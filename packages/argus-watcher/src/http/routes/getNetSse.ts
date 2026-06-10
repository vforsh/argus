import type { NetSseResponse } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'
import { emitRequest } from './types.js'
import { readNetFiltersFromUrl, respondNetDisabled, toNetRequestEventQuery } from './netFilters.js'

export const route = defineJsonRoute<undefined, NetSseResponse>({
	method: 'GET',
	path: '/net/sse',
	handle: ({ res, url, ctx }) => {
		if (!ctx.realtimeNetBuffer) {
			return respondNetDisabled(res)
		}

		const filters = readNetFiltersFromUrl(url, ctx, res)
		if (!filters) {
			return
		}

		emitRequest(ctx, res, 'net/sse', toNetRequestEventQuery(filters))

		const streams = ctx.realtimeNetBuffer.listSseAfter(filters.after, filters, filters.limit)
		const nextAfter = streams.length > 0 ? (streams[streams.length - 1]?.id ?? filters.after) : filters.after
		return { ok: true, streams, nextAfter }
	},
})
