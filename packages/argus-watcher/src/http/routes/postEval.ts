import type { EvalRequest, EvalResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { evaluateExpression } from '../../cdp/eval.js'
import { respondJson, respondInvalidBody, respondError, readJsonBody, normalizeBoolean, normalizeTimeout } from '../httpUtils.js'

export const handle: RouteHandler = async (req, res, _url, ctx) => {
	const payload = await readJsonBody<EvalRequest>(req, res)
	if (!payload) {
		return
	}

	if (!payload.expression || typeof payload.expression !== 'string') {
		return respondInvalidBody(res, 'expression is required')
	}

	emitRequest(ctx, res, 'eval')

	try {
		const response: EvalResponse = await evaluateExpression(ctx.cdpSession, {
			expression: payload.expression,
			awaitPromise: normalizeBoolean(payload.awaitPromise, true),
			returnByValue: normalizeBoolean(payload.returnByValue, true),
			timeoutMs: normalizeTimeout(payload.timeoutMs),
		})
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}
