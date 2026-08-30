import type { CodeGrepRequest, CodeGrepResponse } from '@vforsh/argus-core'
import { codeGrepRequestSchema } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'

export const route = defineJsonRoute<CodeGrepRequest, CodeGrepResponse>({
	method: 'POST',
	path: '/code/grep',
	bodySchema: codeGrepRequestSchema,
	endpoint: 'code/grep',
	handle: ({ ctx, body: payload }) =>
		ctx.runtimeEditor.grep({
			pattern: payload.pattern,
			urlPattern: payload.urlPattern,
		}),
})
