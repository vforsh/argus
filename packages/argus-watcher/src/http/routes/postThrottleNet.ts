import type { NetworkThrottleRequest } from '@vforsh/argus-core'
import { networkThrottleRequestSchema } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'

export const route = defineJsonRoute<NetworkThrottleRequest>({
	method: 'POST',
	path: '/throttle/net',
	bodySchema: networkThrottleRequestSchema,
	endpoint: 'throttle/net',
	handle: ({ ctx, body: payload }) => {
		// Network conditions belong to the page, even when the active Argus target is an iframe.
		const session = ctx.pageCdpSession.isAttached() ? ctx.pageCdpSession : null

		if (payload.action === 'clear') {
			return ctx.networkThrottleController.clearDesired(session)
		}

		return ctx.networkThrottleController.setDesired(payload.conditions, session)
	},
})
