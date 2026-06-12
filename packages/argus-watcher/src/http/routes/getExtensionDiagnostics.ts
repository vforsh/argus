import type { ExtensionDiagnosticsResponse } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'
import { respondJson } from '../httpUtils.js'
import { emitRequest } from './types.js'

export const route = defineJsonRoute<undefined, ExtensionDiagnosticsResponse>({
	method: 'GET',
	path: '/extension/diagnostics',
	extensionOnly: true,
	handle: async ({ res, ctx }) => {
		if (!ctx.sourceHandle?.getExtensionDiagnostics) {
			return respondJson(res, { ok: false, error: { message: 'Not available', code: 'not_available' } }, 400)
		}

		emitRequest(ctx, res, 'extension/diagnostics')
		return await ctx.sourceHandle.getExtensionDiagnostics()
	},
})
