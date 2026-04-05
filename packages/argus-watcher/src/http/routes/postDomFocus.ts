import type { DomFocusRequest, DomFocusResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { readDomTargetPayload, respondMultipleMatches, respondMissingElementRef, respondTargetResolutionError } from './domSelectorRoute.js'
import { emitRequest } from './types.js'
import { focusDomNodes } from '../../cdp/mouse.js'
import { resolveElementTargets } from '../../cdp/dom/selector.js'
import { respondJson, respondError } from '../httpUtils.js'

export const handle: RouteHandler = async (req, res, _url, ctx) => {
	const parsed = await readDomTargetPayload<DomFocusRequest>(req, res)
	if (!parsed) {
		return
	}
	const { payload, all } = parsed

	emitRequest(ctx, res, 'dom/focus')

	try {
		const resolved = await resolveElementTargets(ctx.cdpSession, ctx.elementRefs, {
			selector: payload.selector,
			ref: payload.ref,
			all,
			text: payload.text,
		})
		if (resolved.missingRef && payload.ref) {
			return respondMissingElementRef(res, payload.ref)
		}
		const { allHandles, handles } = resolved

		if (!all && allHandles.length > 1) {
			return respondMultipleMatches(res, allHandles.length, 'focus')
		}

		if (allHandles.length === 0) {
			const response: DomFocusResponse = { ok: true, matches: 0, focused: 0 }
			return respondJson(res, response)
		}

		await focusDomNodes(ctx.cdpSession, handles)
		const response: DomFocusResponse = { ok: true, matches: allHandles.length, focused: handles.length }
		respondJson(res, response)
	} catch (error) {
		if (respondTargetResolutionError(res, error)) {
			return
		}
		respondError(res, error)
	}
}
