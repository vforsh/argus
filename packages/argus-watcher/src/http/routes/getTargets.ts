import { defineJsonRoute } from './defineRoute.js'
import { respondJson } from '../httpUtils.js'
import { emitRequest } from './types.js'

export const route = defineJsonRoute({
	method: 'GET',
	path: '/targets',
	extensionOnly: true,
	handle: async ({ res, ctx }) => {
		if (!ctx.sourceHandle?.listTargets) {
			return respondJson(res, { ok: false, error: { message: 'Not available', code: 'not_available' } }, 400)
		}

		emitRequest(ctx, res, 'targets')
		const targets = await ctx.sourceHandle.listTargets()
		return { ok: true, targets }
	},
})
