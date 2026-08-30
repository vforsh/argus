import type { ExtensionDetachRequest, ExtensionTabActionResponse } from '@vforsh/argus-core'
import { extensionDetachRequestSchema } from '@vforsh/argus-core'
import { defineExtensionRoute } from './defineExtensionRoute.js'
import { resolveExtensionTargetId } from './extensionTarget.js'
import { emitRequest } from './types.js'

export const route = defineExtensionRoute<ExtensionDetachRequest, ExtensionTabActionResponse, 'detachTarget'>({
	method: 'POST',
	path: '/detach',
	bodySchema: extensionDetachRequestSchema,
	capability: 'detachTarget',
	handle: async ({ res, ctx, body: payload, capability }) => {
		emitRequest(ctx, res, 'detach')
		return await capability(resolveExtensionTargetId(payload))
	},
})
