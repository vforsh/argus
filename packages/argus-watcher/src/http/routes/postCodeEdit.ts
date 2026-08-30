import type { CodeEditRequest, CodeEditResponse } from '@vforsh/argus-core'
import { codeEditRequestSchema } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'

export const route = defineJsonRoute<CodeEditRequest, CodeEditResponse>({
	method: 'POST',
	path: '/code/edit',
	bodySchema: codeEditRequestSchema,
	endpoint: 'code/edit',
	handle: ({ ctx, body: payload }) =>
		ctx.runtimeEditor.edit({
			url: payload.url,
			source: payload.source,
		}),
})
