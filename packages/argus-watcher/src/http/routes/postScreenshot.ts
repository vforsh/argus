import type { ScreenshotRequest, ScreenshotResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { respondJson, respondError, readJsonBody } from '../httpUtils.js'

export const handle: RouteHandler = async (req, res, _url, ctx) => {
	const payload = await readJsonBody<ScreenshotRequest>(req, res)
	if (!payload) {
		return
	}

	emitRequest(ctx, res, 'screenshot')

	try {
		const response: ScreenshotResponse = await ctx.screenshotter.capture(payload)
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}
