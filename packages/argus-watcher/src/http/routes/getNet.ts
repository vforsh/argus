import type { NetResponse } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'
import { emitRequest } from './types.js'
import { readNetFiltersFromUrl, respondNetDisabled, toNetRequestEventQuery } from './netFilters.js'

export const route = defineJsonRoute<undefined, NetResponse>({
	method: 'GET',
	path: '/net',
	handle: ({ res, url, ctx }) => {
		if (!ctx.netBuffer) {
			return respondNetDisabled(res)
		}

		const filters = readNetFiltersFromUrl(url, ctx, res)
		if (!filters) {
			return
		}

		emitRequest(ctx, res, 'net', toNetRequestEventQuery(filters))

		const requests = ctx.netBuffer.listAfter(filters.after, filters, filters.limit)
		const nextAfter = requests.length > 0 ? (requests[requests.length - 1]?.id ?? filters.after) : filters.after
		return { ok: true, requests, nextAfter }
	},
})
