import type { NetClearResponse } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'
import { emitRequest } from './types.js'
import { respondJson } from '../httpUtils.js'

export const handle = defineJsonRoute<undefined, NetClearResponse>({
	method: 'POST',
	path: '/net/clear',
	handle: ({ res, ctx }) => {
		if (!ctx.netBuffer) {
			respondJson(res, { ok: false, error: { code: 'net_disabled', message: 'Network capture is disabled for this watcher' } }, 400)
			return
		}

		emitRequest(ctx, res, 'net/clear')
		const realtimeCleared = ctx.realtimeNetBuffer?.clear() ?? 0
		const response: NetClearResponse = {
			ok: true,
			cleared: ctx.netBuffer.clear() + realtimeCleared,
		}
		return response
	},
}).handler
