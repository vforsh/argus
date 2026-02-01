import type { TraceStartRequest, TraceStartResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { respondJson, respondError, readJsonBody } from '../httpUtils.js'

export const handle: RouteHandler = async (req, res, _url, ctx) => {
	const payload = await readJsonBody<TraceStartRequest>(req, res)
	if (!payload) {
		return
	}

	emitRequest(ctx, res, 'trace/start')

	try {
		const response: TraceStartResponse = await ctx.traceRecorder.start(payload)
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}
