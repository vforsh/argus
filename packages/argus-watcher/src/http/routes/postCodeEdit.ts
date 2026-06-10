import type { CodeEditRequest, CodeEditResponse } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'

export const route = defineJsonRoute<CodeEditRequest, CodeEditResponse>({
	method: 'POST',
	path: '/code/edit',
	parseBody: true,
	endpoint: 'code/edit',
	validate: (payload) => {
		if (typeof payload.url !== 'string' || payload.url.trim() === '') {
			return 'url must be a non-empty string'
		}
		if (typeof payload.source !== 'string') {
			return 'source must be a string'
		}
		return null
	},
	handle: ({ ctx, body: payload }) =>
		ctx.runtimeEditor.edit({
			url: payload.url,
			source: payload.source,
		}),
})
