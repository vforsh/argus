import { defineJsonRoute } from './defineRoute.js'

export const route = defineJsonRoute({
	method: 'GET',
	path: '/throttle',
	endpoint: 'throttle',
	handle: ({ ctx }) => ({
		...ctx.throttleController.getStatus({ attached: ctx.getCdpStatus().attached }),
		network: ctx.networkThrottleController.getStatus({ attached: ctx.pageCdpSession.isAttached() }),
	}),
})
