import type { CodeGrepRequest, CodeGrepResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { readJsonBody, respondError, respondInvalidBody, respondJson } from '../httpUtils.js'

export const handle: RouteHandler = async (req, res, _url, ctx) => {
	const payload = await readJsonBody<CodeGrepRequest>(req, res)
	if (!payload) {
		return
	}

	if (typeof payload.pattern !== 'string' || payload.pattern.trim() === '') {
		return respondInvalidBody(res, 'pattern must be a non-empty string')
	}
	if (payload.urlPattern != null && (typeof payload.urlPattern !== 'string' || payload.urlPattern.trim() === '')) {
		return respondInvalidBody(res, 'urlPattern must be a non-empty string')
	}

	emitRequest(ctx, res, 'code/grep')

	try {
		const response: CodeGrepResponse = await ctx.runtimeEditor.grep({
			pattern: payload.pattern,
			urlPattern: payload.urlPattern,
		})
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}
