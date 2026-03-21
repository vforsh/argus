import type { CodeListRequest, CodeListResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { readJsonBody, respondError, respondInvalidBody, respondJson } from '../httpUtils.js'

export const handle: RouteHandler = async (req, res, _url, ctx) => {
	const payload = await readJsonBody<CodeListRequest>(req, res)
	if (!payload) {
		return
	}

	if (payload.pattern != null && (typeof payload.pattern !== 'string' || payload.pattern.trim() === '')) {
		return respondInvalidBody(res, 'pattern must be a non-empty string')
	}

	emitRequest(ctx, res, 'code/list')

	try {
		const response: CodeListResponse = await ctx.runtimeEditor.list({ pattern: payload.pattern })
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}
