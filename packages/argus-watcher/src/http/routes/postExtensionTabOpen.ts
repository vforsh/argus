import type { ExtensionTabOpenRequest, ExtensionTabOpenResponse } from '@vforsh/argus-core'
import { extensionTabOpenRequestSchema } from '@vforsh/argus-core'
import { defineExtensionRoute } from './defineExtensionRoute.js'
import { emitRequest } from './types.js'

export const route = defineExtensionRoute<ExtensionTabOpenRequest, ExtensionTabOpenResponse, 'openTab'>({
	method: 'POST',
	path: '/tabs/open',
	bodySchema: extensionTabOpenRequestSchema,
	capability: 'openTab',
	handle: async ({ res, ctx, body, capability }) => {
		emitRequest(ctx, res, 'tabs/open')
		return await capability(body.url)
	},
})
