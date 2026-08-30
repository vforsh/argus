import type { CodeReadRequest, CodeReadResponse } from '@vforsh/argus-core'
import { codeReadRequestSchema } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'

export const route = defineJsonRoute<CodeReadRequest, CodeReadResponse>({
	method: 'POST',
	path: '/code/read',
	bodySchema: codeReadRequestSchema,
	endpoint: 'code/read',
	handle: ({ ctx, body: payload }) =>
		ctx.runtimeEditor.read({
			url: payload.url,
			offset: payload.offset,
			limit: payload.limit,
		}),
})
