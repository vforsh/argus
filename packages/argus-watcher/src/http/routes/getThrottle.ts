import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { respondJson } from '../httpUtils.js'

export const handle: RouteHandler = (_req, res, _url, ctx) => {
	emitRequest(ctx, res, 'throttle')
	const status = ctx.throttleController.getStatus({ attached: ctx.getCdpStatus().attached })
	respondJson(res, status)
}
