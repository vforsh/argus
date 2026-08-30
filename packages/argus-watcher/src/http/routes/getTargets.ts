import type { ExtensionTargetsResponse } from '@vforsh/argus-core'
import { defineExtensionRoute } from './defineExtensionRoute.js'
import { emitRequest } from './types.js'

export const route = defineExtensionRoute<undefined, ExtensionTargetsResponse, 'listTargets'>({
	method: 'GET',
	path: '/targets',
	capability: 'listTargets',
	handle: async ({ res, ctx, capability }) => {
		emitRequest(ctx, res, 'targets')
		return { ok: true, targets: await capability() }
	},
})
