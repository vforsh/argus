import type { CodeReadRequest, CodeReadResponse } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'

export const route = defineJsonRoute<CodeReadRequest, CodeReadResponse>({
	method: 'POST',
	path: '/code/read',
	parseBody: true,
	endpoint: 'code/read',
	validate: (payload) => {
		if (typeof payload.url !== 'string' || payload.url.trim() === '') {
			return 'url must be a non-empty string'
		}
		if (payload.offset != null && (!Number.isInteger(payload.offset) || payload.offset < 0)) {
			return 'offset must be a non-negative integer'
		}
		if (payload.limit != null && (!Number.isInteger(payload.limit) || payload.limit <= 0)) {
			return 'limit must be a positive integer'
		}
		return null
	},
	handle: ({ ctx, body: payload }) =>
		ctx.runtimeEditor.read({
			url: payload.url,
			offset: payload.offset,
			limit: payload.limit,
		}),
})
