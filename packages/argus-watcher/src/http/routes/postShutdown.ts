import type { ShutdownResponse } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'
import { respondJson } from '../httpUtils.js'

export const route = defineJsonRoute({
	method: 'POST',
	path: '/shutdown',
	endpoint: 'shutdown',
	handle: ({ res, ctx }) => {
		// Respond before scheduling shutdown so the response reliably reaches the client.
		respondJson(res, { ok: true } satisfies ShutdownResponse)

		if (ctx.onShutdown) {
			queueMicrotask(() => {
				void ctx.onShutdown?.()
			})
		}
	},
})
