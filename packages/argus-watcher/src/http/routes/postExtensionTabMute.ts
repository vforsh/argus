import type { ExtensionTabMuteRequest, ExtensionTabMuteResponse } from '@vforsh/argus-core'
import { extensionTabMuteRequestSchema } from '@vforsh/argus-core'
import { defineExtensionRoute } from './defineExtensionRoute.js'
import { emitRequest } from './types.js'

export const route = defineExtensionRoute<ExtensionTabMuteRequest, ExtensionTabMuteResponse, 'setTabMuted'>({
	method: 'POST',
	path: '/tabs/mute',
	bodySchema: extensionTabMuteRequestSchema,
	capability: 'setTabMuted',
	handle: async ({ res, ctx, body, capability }) => {
		emitRequest(ctx, res, 'tabs/mute')
		return await capability(body.tabId, body.muted)
	},
})
