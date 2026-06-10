import type { CodeGrepRequest, CodeGrepResponse } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'

export const route = defineJsonRoute<CodeGrepRequest, CodeGrepResponse>({
	method: 'POST',
	path: '/code/grep',
	parseBody: true,
	endpoint: 'code/grep',
	validate: (payload) => {
		if (typeof payload.pattern !== 'string' || payload.pattern.trim() === '') {
			return 'pattern must be a non-empty string'
		}
		if (payload.urlPattern != null && (typeof payload.urlPattern !== 'string' || payload.urlPattern.trim() === '')) {
			return 'urlPattern must be a non-empty string'
		}
		return null
	},
	handle: ({ ctx, body: payload }) =>
		ctx.runtimeEditor.grep({
			pattern: payload.pattern,
			urlPattern: payload.urlPattern,
		}),
})
