import type { EmulationRequest } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { respondJson, respondInvalidBody, respondError, readJsonBody } from '../httpUtils.js'

export const handle: RouteHandler = async (req, res, _url, ctx) => {
	const payload = await readJsonBody<EmulationRequest>(req, res)
	if (!payload) {
		return
	}

	const validActions = ['set', 'clear'] as const
	const action = (payload as { action?: string }).action
	if (!action || !validActions.includes(action as (typeof validActions)[number])) {
		return respondInvalidBody(res, `action must be one of: ${validActions.join(', ')}`)
	}

	emitRequest(ctx, res, 'emulation')

	if (action === 'clear') {
		try {
			const session = ctx.cdpSession.isAttached() ? ctx.cdpSession : null
			const response = await ctx.emulationController.clearDesired(session)
			respondJson(res, response)
		} catch (error) {
			respondError(res, error)
		}
		return
	}

	// action === 'set'
	const setPayload = payload as { action: 'set'; state?: unknown }
	if (!setPayload.state || typeof setPayload.state !== 'object') {
		return respondInvalidBody(res, 'state is required for set action')
	}

	const state = setPayload.state as Record<string, unknown>

	// Validate viewport if present
	if (state.viewport != null) {
		const vp = state.viewport as Record<string, unknown>
		if (!Number.isInteger(vp.width) || (vp.width as number) <= 0) {
			return respondInvalidBody(res, 'viewport.width must be a positive integer')
		}
		if (!Number.isInteger(vp.height) || (vp.height as number) <= 0) {
			return respondInvalidBody(res, 'viewport.height must be a positive integer')
		}
		if (typeof vp.deviceScaleFactor !== 'number' || !Number.isFinite(vp.deviceScaleFactor) || (vp.deviceScaleFactor as number) <= 0) {
			return respondInvalidBody(res, 'viewport.deviceScaleFactor must be a finite number > 0')
		}
		if (typeof vp.mobile !== 'boolean') {
			return respondInvalidBody(res, 'viewport.mobile must be a boolean')
		}
	}

	// Validate touch if present
	if (state.touch != null) {
		const touch = state.touch as Record<string, unknown>
		if (typeof touch.enabled !== 'boolean') {
			return respondInvalidBody(res, 'touch.enabled must be a boolean')
		}
	}

	// Validate userAgent if present
	if (state.userAgent != null) {
		const ua = state.userAgent as Record<string, unknown>
		if (ua.value !== null && (typeof ua.value !== 'string' || ua.value === '')) {
			return respondInvalidBody(res, 'userAgent.value must be a non-empty string or null')
		}
	}

	try {
		const session = ctx.cdpSession.isAttached() ? ctx.cdpSession : null
		const response = await ctx.emulationController.setDesired(state as import('@vforsh/argus-core').EmulationState, session)
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}
