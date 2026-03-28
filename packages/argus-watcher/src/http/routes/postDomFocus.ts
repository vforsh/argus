import type { DomFocusRequest, DomFocusResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { readDomSelectorPayload, respondMultipleMatches } from './domSelectorRoute.js'
import { emitRequest } from './types.js'
import { resolveDomSelectorMatches, focusDomNodes } from '../../cdp/mouse.js'
import { respondJson, respondError } from '../httpUtils.js'

export const handle: RouteHandler = async (req, res, _url, ctx) => {
	const parsed = await readDomSelectorPayload<DomFocusRequest>(req, res)
	if (!parsed) {
		return
	}
	const { payload, all } = parsed

	emitRequest(ctx, res, 'dom/focus')

	try {
		const { allNodeIds, nodeIds } = await resolveDomSelectorMatches(ctx.cdpSession, payload.selector, all, payload.text)

		if (!all && allNodeIds.length > 1) {
			return respondMultipleMatches(res, allNodeIds.length, 'focus')
		}

		if (allNodeIds.length === 0) {
			const response: DomFocusResponse = { ok: true, matches: 0, focused: 0 }
			return respondJson(res, response)
		}

		await focusDomNodes(ctx.cdpSession, nodeIds)
		const response: DomFocusResponse = { ok: true, matches: allNodeIds.length, focused: nodeIds.length }
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}
