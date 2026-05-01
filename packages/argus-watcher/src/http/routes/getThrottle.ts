import { defineJsonRoute } from './defineRoute.js'

export const handle = defineJsonRoute({
	method: 'GET',
	path: '/throttle',
	endpoint: 'throttle',
	handle: ({ ctx }) => ctx.throttleController.getStatus({ attached: ctx.getCdpStatus().attached }),
}).handler
