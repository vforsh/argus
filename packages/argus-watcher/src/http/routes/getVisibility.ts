import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { respondJson } from '../httpUtils.js'

export const handle: RouteHandler = (_req, res, _url, ctx) => {
	emitRequest(ctx, res, 'visibility')
	const attached = ctx.getCdpStatus().attached
	respondJson(res, ctx.visibilityController.getResponse({ attached }))
}
