import type { ExtensionDetachRequest, ExtensionTabActionResponse } from '@vforsh/argus-core'
import { extensionDetachRequestSchema } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'
import { respondJson } from '../httpUtils.js'
import { emitRequest } from './types.js'

export const route = defineJsonRoute<ExtensionDetachRequest, ExtensionTabActionResponse>({
	method: 'POST',
	path: '/detach',
	bodySchema: extensionDetachRequestSchema,
	extensionOnly: true,
	handle: async ({ res, ctx, body: payload }) => {
		if (!ctx.sourceHandle?.detachTarget) {
			return respondJson(res, { ok: false, error: { message: 'Not available', code: 'not_available' } }, 400)
		}

		const targetId = payload.targetId ?? String(payload.tabId)

		emitRequest(ctx, res, 'detach')
		return await ctx.sourceHandle.detachTarget(targetId)
	},
	handleError: (res, error) => {
		respondJson(
			res,
			{ ok: false, error: { message: error instanceof Error ? error.message : String(error), code: 'extension_action_failed' } },
			400,
		)
		return true
	},
})
