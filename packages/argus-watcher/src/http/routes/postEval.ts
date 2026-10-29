import type { EvalRequest, EvalResponse } from '@vforsh/argus-core'
import { evalRequestSchema } from '@vforsh/argus-core'
import { evaluateExpression, ScenarioTimeoutError } from '../../cdp/eval.js'
import { assertNavigatedPast } from '../../cdp/documentIdentity.js'
import type { CdpHealthDiagnosis } from '../../cdp/health.js'
import type { RouteContext } from './types.js'
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
	handle: async ({ ctx, body: payload }) => {
		try {
			return await runEval(ctx, payload)
		} catch (error) {
			if (!(error instanceof ScenarioTimeoutError)) throw error
			return await respondWithProgress(ctx, error)
		}
	},
})

const runEval = async (ctx: RouteContext, payload: EvalRequest): Promise<EvalResponse> => {
	const timeoutMs = normalizeTimeout(payload.timeoutMs) ?? DEFAULT_EVAL_CDP_TIMEOUT_MS
	if (payload.navigatedFrom != null) {
		await assertNavigatedPast({ page: ctx.pageCdpSession, target: ctx.cdpSession }, payload.navigatedFrom, timeoutMs)
	}
	return evaluateExpression(ctx.cdpSession, {
		expression: payload.expression,
		args: normalizeEvalArgs(payload.args),
		awaitPromise: normalizeBoolean(payload.awaitPromise, true),
		replMode: normalizeBoolean(payload.replMode, true),
		returnByValue: normalizeBoolean(payload.returnByValue, true),
		jsonValue: normalizeBoolean(payload.jsonValue, false),
		timeoutMs,
		scenario: normalizeBoolean(payload.scenario, false),
		scenarioServices: {
			buffer: ctx.buffer,
			screenshotter: ctx.screenshotter,
			recorder: ctx.recorder,
		},
	})
}

/** Return the scenario's last progress snapshot, labeled with the same diagnosis a bare timeout gets. */
const respondWithProgress = async (ctx: RouteContext, error: ScenarioTimeoutError): Promise<EvalResponse> => {
	const diagnosis = await diagnoseQuietly(ctx)
	const { value, at } = error.progress
	return {
		ok: true,
		result: value,
		type: value === null ? 'object' : typeof value,
		exception: null,
		timedOut: { code: diagnosis.code, message: `${error.message}. ${diagnosis.message}`, progressAt: at },
	}
}

const diagnoseQuietly = async (ctx: RouteContext): Promise<CdpHealthDiagnosis> => {
	try {
		if (ctx.diagnoseCdp) return await ctx.diagnoseCdp()
	} catch {
		// The diagnosis is a label on data we already have; never let it cost the data.
	}
	return { code: 'cdp_timeout', message: 'The scenario exceeded its deadline. Pass a longer timeout.' }
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
