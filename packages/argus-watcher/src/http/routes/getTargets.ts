import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { respondJson, respondError } from '../httpUtils.js'

export const handle: RouteHandler = async (_req, res, _url, ctx) => {
	if (!ctx.sourceHandle?.listTargets) {
		return respondJson(res, { ok: false, error: { message: 'Not available', code: 'not_available' } }, 400)
	}

	emitRequest(ctx, res, 'targets')

	try {
		const targets = await ctx.sourceHandle.listTargets()
		respondJson(res, { ok: true, targets })
	} catch (error) {
		respondError(res, error)
	}
}
