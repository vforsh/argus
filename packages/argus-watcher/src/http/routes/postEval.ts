import type { EvalRequest, EvalResponse } from '@vforsh/argus-core'
import { evalRequestSchema } from '@vforsh/argus-core'
import { evaluateExpression } from '../../cdp/eval.js'
import { defineJsonRoute } from './defineRoute.js'
import { normalizeBoolean, normalizeTimeout } from '../httpUtils.js'

/**
 * Deadline applied when the caller names none.
 *
 * Without it a wedged renderer leaves `Runtime.evaluate` pending forever and the failure surfaces
 * on the *client's* clock, where nothing knows why — the watcher can diagnose the stall only if it
 * is the one that gives up. Generous on purpose: it is a backstop, not a policy.
 */
const DEFAULT_EVAL_CDP_TIMEOUT_MS = 30_000

export const route = defineJsonRoute<EvalRequest, EvalResponse>({
	method: 'POST',
	path: '/eval',
	bodySchema: evalRequestSchema,
	endpoint: 'eval',
	handle: ({ ctx, body: payload }) =>
		evaluateExpression(ctx.cdpSession, {
			expression: payload.expression,
			args: normalizeEvalArgs(payload.args),
			awaitPromise: normalizeBoolean(payload.awaitPromise, true),
			replMode: normalizeBoolean(payload.replMode, true),
			returnByValue: normalizeBoolean(payload.returnByValue, true),
			jsonValue: normalizeBoolean(payload.jsonValue, false),
			timeoutMs: normalizeTimeout(payload.timeoutMs) ?? DEFAULT_EVAL_CDP_TIMEOUT_MS,
			scenario: normalizeBoolean(payload.scenario, false),
			scenarioServices: {
				buffer: ctx.buffer,
				screenshotter: ctx.screenshotter,
				recorder: ctx.recorder,
			},
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
