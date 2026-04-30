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
			args: normalizeEvalArgs(payload.args),
			awaitPromise: normalizeBoolean(payload.awaitPromise, true),
			replMode: normalizeBoolean(payload.replMode, true),
			returnByValue: normalizeBoolean(payload.returnByValue, true),
			timeoutMs: normalizeTimeout(payload.timeoutMs),
		})
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}

const normalizeEvalArgs = (args: EvalRequest['args']): Record<string, string> | undefined => {
	if (args == null || typeof args !== 'object' || Array.isArray(args)) {
		return undefined
	}

	const normalized: Record<string, string> = {}
	for (const [key, value] of Object.entries(args)) {
		if (typeof value === 'string') {
			normalized[key] = value
		}
	}

	return Object.keys(normalized).length > 0 ? normalized : undefined
}
