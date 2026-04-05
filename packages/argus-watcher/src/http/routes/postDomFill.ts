import type { DomFillRequest, DomFillResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { respondMissingElementRef, respondMultipleMatches, respondTargetResolutionError } from './domSelectorRoute.js'
import { emitRequest } from './types.js'
import { fillResolvedNodes } from '../../cdp/dom.js'
import { resolveElementTargets } from '../../cdp/dom/selector.js'
import { respondJson, respondInvalidBody, respondError, readJsonBody } from '../httpUtils.js'

export const handle: RouteHandler = async (req, res, _url, ctx) => {
	const payload = await readJsonBody<DomFillRequest>(req, res)
	if (!payload) {
		return
	}

	const hasSelector = typeof payload.selector === 'string' && payload.selector.trim() !== ''
	const hasRef = typeof payload.ref === 'string' && payload.ref.trim() !== ''
	if (hasSelector === hasRef) {
		return respondInvalidBody(res, 'Exactly one of selector or ref is required')
	}

	if (typeof payload.value !== 'string') {
		return respondInvalidBody(res, 'value is required')
	}

	const all = payload.all ?? false
	if (typeof all !== 'boolean') {
		return respondInvalidBody(res, 'all must be a boolean')
	}

	const waitMs = payload.wait ?? 0
	if (typeof waitMs !== 'number' || !Number.isFinite(waitMs) || waitMs < 0) {
		return respondInvalidBody(res, 'wait must be a non-negative number (ms)')
	}

	emitRequest(ctx, res, 'dom/fill')

	try {
		const resolved = await resolveElementTargets(ctx.cdpSession, ctx.elementRefs, {
			selector: payload.selector,
			ref: payload.ref,
			all,
			text: payload.text,
			waitMs,
		})
		if (resolved.missingRef && payload.ref) {
			return respondMissingElementRef(res, payload.ref)
		}
		const { allHandles, handles } = resolved

		if (!all && allHandles.length > 1) {
			return respondMultipleMatches(res, allHandles.length, 'fill')
		}

		const filledCount = await fillResolvedNodes(ctx.cdpSession, handles, payload.value)
		const response: DomFillResponse = { ok: true, matches: allHandles.length, filled: filledCount }
		respondJson(res, response)
	} catch (error) {
		if (respondTargetResolutionError(res, error)) {
			return
		}
		respondError(res, error)
	}
}
