import type { ExtensionTabActionResponse } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'
import { respondInvalidBody, respondJson } from '../httpUtils.js'
import { emitRequest } from './types.js'

export const route = defineJsonRoute<{ tabId?: number; targetId?: string }, ExtensionTabActionResponse>({
	method: 'POST',
	path: '/detach',
	parseBody: true,
	extensionOnly: true,
	handle: async ({ res, ctx, body: payload }) => {
		if (!ctx.sourceHandle?.detachTarget) {
			return respondJson(res, { ok: false, error: { message: 'Not available', code: 'not_available' } }, 400)
		}

		const targetId = typeof payload.targetId === 'string' ? payload.targetId : typeof payload.tabId === 'number' ? String(payload.tabId) : null
		if (!targetId) {
			return respondInvalidBody(res, 'targetId is required')
		}

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
