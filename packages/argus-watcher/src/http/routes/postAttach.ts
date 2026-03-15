import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { respondJson, respondInvalidBody, respondError, readJsonBody } from '../httpUtils.js'

export const handle: RouteHandler = async (req, res, _url, ctx) => {
	if (!ctx.sourceHandle?.attachTarget) {
		return respondJson(res, { ok: false, error: { message: 'Not available', code: 'not_available' } }, 400)
	}

	const payload = await readJsonBody<{ tabId?: number; targetId?: string }>(req, res)
	if (!payload) {
		return
	}

	const targetId = typeof payload.targetId === 'string' ? payload.targetId : typeof payload.tabId === 'number' ? String(payload.tabId) : null
	if (!targetId) {
		return respondInvalidBody(res, 'targetId is required')
	}

	emitRequest(ctx, res, 'attach')

	try {
		ctx.sourceHandle.attachTarget(targetId)
		respondJson(res, { ok: true, message: 'Attach request sent' })
	} catch (error) {
		respondError(res, error)
	}
}
