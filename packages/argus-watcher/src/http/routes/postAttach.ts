import type { ExtensionAttachRequest, ExtensionTabActionResponse } from '@vforsh/argus-core'
import { extensionAttachRequestSchema } from '@vforsh/argus-core'
import { defineExtensionRoute } from './defineExtensionRoute.js'
import { resolveExtensionTargetId } from './extensionTarget.js'
import { emitRequest } from './types.js'

export const route = defineExtensionRoute<ExtensionAttachRequest, ExtensionTabActionResponse, 'attachTarget'>({
	method: 'POST',
	path: '/attach',
	bodySchema: extensionAttachRequestSchema,
	capability: 'attachTarget',
	handle: async ({ res, ctx, body: payload, capability }) => {
		emitRequest(ctx, res, 'attach')
		return await capability(resolveExtensionTargetId(payload), { watcherId: payload.watcherId })
	},
})
