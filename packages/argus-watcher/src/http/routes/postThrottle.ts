import type { ThrottleRequest } from '@vforsh/argus-core'
import { throttleRequestSchema } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'

export const route = defineJsonRoute<ThrottleRequest>({
	method: 'POST',
	path: '/throttle',
	bodySchema: throttleRequestSchema,
	endpoint: 'throttle',
	handle: ({ ctx, body: payload }) => {
		const session = ctx.cdpSession.isAttached() ? ctx.cdpSession : null

		if (payload.action === 'clear') {
			return ctx.throttleController.clearDesired(session)
		}

		return ctx.throttleController.setDesired(payload.rate, session)
	},
})
