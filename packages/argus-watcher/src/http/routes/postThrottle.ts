import type { ThrottleRequest } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'

const validActions = ['set', 'clear'] as const

export const route = defineJsonRoute<ThrottleRequest>({
	method: 'POST',
	path: '/throttle',
	parseBody: true,
	endpoint: 'throttle',
	validate: (payload) => {
		const action = (payload as { action?: string }).action
		if (!action || !validActions.includes(action as (typeof validActions)[number])) {
			return `action must be one of: ${validActions.join(', ')}`
		}
		if (action === 'set') {
			const rate = (payload as { rate?: unknown }).rate
			if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 1) {
				return 'rate must be a finite number >= 1'
			}
		}
		return null
	},
	handle: ({ ctx, body: payload }) => {
		const session = ctx.cdpSession.isAttached() ? ctx.cdpSession : null

		if (payload.action === 'clear') {
			return ctx.throttleController.clearDesired(session)
		}

		return ctx.throttleController.setDesired((payload as { rate: number }).rate, session)
	},
})
