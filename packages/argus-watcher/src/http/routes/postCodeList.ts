import type { CodeListRequest, CodeListResponse } from '@vforsh/argus-core'
import { codeListRequestSchema } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'

export const route = defineJsonRoute<CodeListRequest, CodeListResponse>({
	method: 'POST',
	path: '/code/list',
	bodySchema: codeListRequestSchema,
	endpoint: 'code/list',
	handle: ({ ctx, body: payload }) => ctx.runtimeEditor.list({ pattern: payload.pattern }),
})
