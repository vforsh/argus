import type { VisibilityResponse } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'

export const route = defineJsonRoute({
	method: 'GET',
	path: '/visibility',
	endpoint: 'visibility',
	handle: ({ ctx }): VisibilityResponse => ({
		ok: true,
		attached: ctx.pageCdpSession.isAttached(),
		state: ctx.visibilityController.getDesired(),
		policy: ctx.visibilityController.getPolicy(),
	}),
})
