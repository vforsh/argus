import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { respondJson, respondInvalidBody, respondError, readJsonBody } from '../httpUtils.js'

export const handle: RouteHandler = async (req, res, _url, ctx) => {
	if (!ctx.sourceHandle?.detachTarget) {
		return respondJson(res, { ok: false, error: { message: 'Not available', code: 'not_available' } }, 400)
	}

	const payload = await readJsonBody<{ tabId: number }>(req, res)
	if (!payload) {
		return
	}

	if (typeof payload.tabId !== 'number') {
		return respondInvalidBody(res, 'tabId is required')
	}

	emitRequest(ctx, res, 'detach')

	try {
		ctx.sourceHandle.detachTarget(payload.tabId)
		respondJson(res, { ok: true, message: 'Detach request sent' })
	} catch (error) {
		respondError(res, error)
	}
}
