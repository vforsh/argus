import type { NetClearResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { respondJson } from '../httpUtils.js'

export const handle: RouteHandler = (_req, res, _url, ctx) => {
	if (!ctx.netBuffer) {
		return respondJson(res, { ok: false, error: { code: 'net_disabled', message: 'Network capture is disabled for this watcher' } }, 400)
	}

	emitRequest(ctx, res, 'net/clear')

	const response: NetClearResponse = {
		ok: true,
		cleared: ctx.netBuffer.clear(),
	}
	respondJson(res, response)
}
