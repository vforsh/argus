import type { ExtensionAttachRequest, ExtensionTabActionResponse } from '@vforsh/argus-core'
import { extensionAttachRequestSchema } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'
import { respondJson } from '../httpUtils.js'
import { emitRequest } from './types.js'

export const route = defineJsonRoute<ExtensionAttachRequest, ExtensionTabActionResponse>({
	method: 'POST',
	path: '/attach',
	bodySchema: extensionAttachRequestSchema,
	extensionOnly: true,
	handle: async ({ res, ctx, body: payload }) => {
		if (!ctx.sourceHandle?.attachTarget) {
			return respondJson(res, { ok: false, error: { message: 'Not available', code: 'not_available' } }, 400)
		}

		const targetId = payload.targetId ?? String(payload.tabId)

		emitRequest(ctx, res, 'attach')
		return await ctx.sourceHandle.attachTarget(targetId, { watcherId: payload.watcherId })
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
