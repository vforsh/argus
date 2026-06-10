import type { EvalRequest, EvalResponse } from '@vforsh/argus-core'
import { evaluateExpression } from '../../cdp/eval.js'
import { defineJsonRoute } from './defineRoute.js'
import { normalizeBoolean, normalizeTimeout } from '../httpUtils.js'

export const route = defineJsonRoute<EvalRequest, EvalResponse>({
	method: 'POST',
	path: '/eval',
	parseBody: true,
	endpoint: 'eval',
	validate: (payload) => {
		if (!payload.expression || typeof payload.expression !== 'string') {
			return 'expression is required'
		}
		return null
	},
	handle: ({ ctx, body: payload }) =>
		evaluateExpression(ctx.cdpSession, {
			expression: payload.expression,
			args: normalizeEvalArgs(payload.args),
			awaitPromise: normalizeBoolean(payload.awaitPromise, true),
			replMode: normalizeBoolean(payload.replMode, true),
			returnByValue: normalizeBoolean(payload.returnByValue, true),
			timeoutMs: normalizeTimeout(payload.timeoutMs),
		}),
})

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
