import type { ThrottleRequest } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { respondJson, respondInvalidBody, respondError, readJsonBody } from '../httpUtils.js'

export const handle: RouteHandler = async (req, res, _url, ctx) => {
	const payload = await readJsonBody<ThrottleRequest>(req, res)
	if (!payload) {
		return
	}

	const validActions = ['set', 'clear'] as const
	const action = (payload as { action?: string }).action
	if (!action || !validActions.includes(action as (typeof validActions)[number])) {
		return respondInvalidBody(res, `action must be one of: ${validActions.join(', ')}`)
	}

	emitRequest(ctx, res, 'throttle')

	const session = ctx.cdpSession.isAttached() ? ctx.cdpSession : null

	if (action === 'clear') {
		try {
			const response = await ctx.throttleController.clearDesired(session)
			respondJson(res, response)
		} catch (error) {
			respondError(res, error)
		}
		return
	}

	// action === 'set'
	const setPayload = payload as { rate?: unknown }
	if (typeof setPayload.rate !== 'number' || !Number.isFinite(setPayload.rate) || setPayload.rate < 1) {
		return respondInvalidBody(res, 'rate must be a finite number >= 1')
	}

	try {
		const response = await ctx.throttleController.setDesired(setPayload.rate, session)
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}
