import type { ThrottleRequest } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'
import { emitRequest } from './types.js'
import { respondInvalidBody } from '../httpUtils.js'

export const handle = defineJsonRoute<ThrottleRequest>({
	method: 'POST',
	path: '/throttle',
	parseBody: true,
	handle: async ({ res, ctx, body: payload }) => {
		const validActions = ['set', 'clear'] as const
		const action = (payload as { action?: string }).action
		if (!action || !validActions.includes(action as (typeof validActions)[number])) {
			return respondInvalidBody(res, `action must be one of: ${validActions.join(', ')}`)
		}

		emitRequest(ctx, res, 'throttle')

		const session = ctx.cdpSession.isAttached() ? ctx.cdpSession : null

		if (action === 'clear') {
			return ctx.throttleController.clearDesired(session)
		}

		// action === 'set'
		const setPayload = payload as { rate?: unknown }
		if (typeof setPayload.rate !== 'number' || !Number.isFinite(setPayload.rate) || setPayload.rate < 1) {
			return respondInvalidBody(res, 'rate must be a finite number >= 1')
		}

		return ctx.throttleController.setDesired(setPayload.rate, session)
	},
}).handler
