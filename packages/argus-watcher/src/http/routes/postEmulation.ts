import type { EmulationRequest } from '@vforsh/argus-core'
import { emulationRequestSchema } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'

export const route = defineJsonRoute<EmulationRequest>({
	method: 'POST',
	path: '/emulation',
	bodySchema: emulationRequestSchema,
	endpoint: 'emulation',
	handle: async ({ ctx, body: payload }) => {
		const session = ctx.cdpSession.isAttached() ? ctx.cdpSession : null

		if (payload.action === 'clear') {
			return ctx.emulationController.clearDesired(session)
		}

		return ctx.emulationController.setDesired(payload.state, session)
	},
})
