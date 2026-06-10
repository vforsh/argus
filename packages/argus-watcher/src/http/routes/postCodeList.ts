import type { CodeListRequest, CodeListResponse } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'

export const route = defineJsonRoute<CodeListRequest, CodeListResponse>({
	method: 'POST',
	path: '/code/list',
	parseBody: true,
	endpoint: 'code/list',
	validate: (payload) => {
		if (payload.pattern != null && (typeof payload.pattern !== 'string' || payload.pattern.trim() === '')) {
			return 'pattern must be a non-empty string'
		}
		return null
	},
	handle: ({ ctx, body: payload }) => ctx.runtimeEditor.list({ pattern: payload.pattern }),
})
