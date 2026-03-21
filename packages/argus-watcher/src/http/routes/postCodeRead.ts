import type { CodeReadRequest, CodeReadResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { readJsonBody, respondError, respondInvalidBody, respondJson } from '../httpUtils.js'

export const handle: RouteHandler = async (req, res, _url, ctx) => {
	const payload = await readJsonBody<CodeReadRequest>(req, res)
	if (!payload) {
		return
	}

	if (typeof payload.url !== 'string' || payload.url.trim() === '') {
		return respondInvalidBody(res, 'url must be a non-empty string')
	}
	if (payload.offset != null && (!Number.isInteger(payload.offset) || payload.offset < 0)) {
		return respondInvalidBody(res, 'offset must be a non-negative integer')
	}
	if (payload.limit != null && (!Number.isInteger(payload.limit) || payload.limit <= 0)) {
		return respondInvalidBody(res, 'limit must be a positive integer')
	}

	emitRequest(ctx, res, 'code/read')

	try {
		const response: CodeReadResponse = await ctx.runtimeEditor.read({
			url: payload.url,
			offset: payload.offset,
			limit: payload.limit,
		})
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}
