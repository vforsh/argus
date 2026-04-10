import type { CodeEditRequest, CodeEditResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { readJsonBody, respondError, respondInvalidBody, respondJson } from '../httpUtils.js'

export const handle: RouteHandler = async (req, res, _url, ctx) => {
	const payload = await readJsonBody<CodeEditRequest>(req, res)
	if (!payload) {
		return
	}

	if (typeof payload.url !== 'string' || payload.url.trim() === '') {
		return respondInvalidBody(res, 'url must be a non-empty string')
	}
	if (typeof payload.source !== 'string') {
		return respondInvalidBody(res, 'source must be a string')
	}

	emitRequest(ctx, res, 'code/edit')

	try {
		const response: CodeEditResponse = await ctx.runtimeEditor.edit({
			url: payload.url,
			source: payload.source,
		})
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}
