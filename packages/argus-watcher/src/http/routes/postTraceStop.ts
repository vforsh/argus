import type { TraceStopRequest, TraceStopResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { respondJson, respondError, readJsonBody } from '../httpUtils.js'

export const handle: RouteHandler = async (req, res, _url, ctx) => {
	const payload = await readJsonBody<TraceStopRequest>(req, res)
	if (!payload) {
		return
	}

	emitRequest(ctx, res, 'trace/stop')

	try {
		const response: TraceStopResponse = await ctx.traceRecorder.stop(payload)
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}
