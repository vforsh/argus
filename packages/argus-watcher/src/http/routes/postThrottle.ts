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

	if (action === 'clear') {
		try {
			const session = ctx.cdpSession.isAttached() ? ctx.cdpSession : null
			const clearPayload = payload as { aspects?: unknown }
			let aspects: ('cpu' | 'network' | 'cache')[] | undefined

			if (clearPayload.aspects != null) {
				if (!Array.isArray(clearPayload.aspects)) {
					return respondInvalidBody(res, 'aspects must be an array')
				}
				const validAspects = ['cpu', 'network', 'cache'] as const
				for (const a of clearPayload.aspects) {
					if (!validAspects.includes(a as (typeof validAspects)[number])) {
						return respondInvalidBody(res, `invalid aspect: ${a}. Must be one of: ${validAspects.join(', ')}`)
					}
				}
				aspects = clearPayload.aspects as ('cpu' | 'network' | 'cache')[]
			}

			const response = await ctx.throttleController.clearDesired(aspects, session)
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

	// Validate cpu if present
	if (state.cpu != null) {
		const cpu = state.cpu as Record<string, unknown>
		if (typeof cpu.rate !== 'number' || !Number.isFinite(cpu.rate) || cpu.rate < 1) {
			return respondInvalidBody(res, 'cpu.rate must be a finite number >= 1')
		}
	}

	// Validate network if present
	if (state.network != null) {
		const net = state.network as Record<string, unknown>
		if (typeof net.offline !== 'boolean') {
			return respondInvalidBody(res, 'network.offline must be a boolean')
		}
		if (typeof net.latency !== 'number' || !Number.isFinite(net.latency) || net.latency < 0) {
			return respondInvalidBody(res, 'network.latency must be a finite number >= 0')
		}
		if (typeof net.downloadThroughput !== 'number' || !Number.isFinite(net.downloadThroughput)) {
			return respondInvalidBody(res, 'network.downloadThroughput must be a finite number')
		}
		if (typeof net.uploadThroughput !== 'number' || !Number.isFinite(net.uploadThroughput)) {
			return respondInvalidBody(res, 'network.uploadThroughput must be a finite number')
		}
	}

	// Validate cache if present
	if (state.cache != null) {
		const cache = state.cache as Record<string, unknown>
		if (typeof cache.disabled !== 'boolean') {
			return respondInvalidBody(res, 'cache.disabled must be a boolean')
		}
	}

	try {
		const session = ctx.cdpSession.isAttached() ? ctx.cdpSession : null
		const response = await ctx.throttleController.setDesired(state as import('@vforsh/argus-core').ThrottleState, session)
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}
