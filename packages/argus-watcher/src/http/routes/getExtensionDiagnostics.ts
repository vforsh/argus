import type { ExtensionDiagnosticsResponse } from '@vforsh/argus-core'
import { defineExtensionRoute } from './defineExtensionRoute.js'
import { emitRequest } from './types.js'

export const route = defineExtensionRoute<undefined, ExtensionDiagnosticsResponse, 'getExtensionDiagnostics'>({
	method: 'GET',
	path: '/extension/diagnostics',
	capability: 'getExtensionDiagnostics',
	handle: async ({ res, ctx, capability }) => {
		emitRequest(ctx, res, 'extension/diagnostics')
		return await capability()
	},
})
