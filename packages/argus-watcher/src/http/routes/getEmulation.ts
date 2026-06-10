import { defineJsonRoute } from './defineRoute.js'

export const route = defineJsonRoute({
	method: 'GET',
	path: '/emulation',
	endpoint: 'emulation',
	handle: ({ ctx }) => ctx.emulationController.getStatus({ attached: ctx.getCdpStatus().attached }),
})
