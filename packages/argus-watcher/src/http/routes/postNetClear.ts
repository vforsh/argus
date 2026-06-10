import type { NetClearResponse } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'
import { emitRequest } from './types.js'
import { respondNetDisabled } from './netFilters.js'

export const route = defineJsonRoute<undefined, NetClearResponse>({
	method: 'POST',
	path: '/net/clear',
	handle: ({ res, ctx }) => {
		if (!ctx.netBuffer) {
			return respondNetDisabled(res)
		}

		emitRequest(ctx, res, 'net/clear')
		const realtimeCleared = ctx.realtimeNetBuffer?.clear() ?? 0
		return { ok: true, cleared: ctx.netBuffer.clear() + realtimeCleared }
	},
})
