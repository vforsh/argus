import type { DomHoverRequest, DomHoverResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { readDomSelectorPayload, respondMultipleMatches } from './domSelectorRoute.js'
import { emitRequest } from './types.js'
import { resolveDomSelectorMatches, hoverDomNodes } from '../../cdp/mouse.js'
import { respondJson, respondError } from '../httpUtils.js'

export const handle: RouteHandler = async (req, res, _url, ctx) => {
	const parsed = await readDomSelectorPayload<DomHoverRequest>(req, res)
	if (!parsed) {
		return
	}
	const { payload, all } = parsed

	emitRequest(ctx, res, 'dom/hover')

	try {
		const { allNodeIds, nodeIds } = await resolveDomSelectorMatches(ctx.cdpSession, payload.selector, all, payload.text)

		if (!all && allNodeIds.length > 1) {
			return respondMultipleMatches(res, allNodeIds.length, 'hover')
		}

		if (allNodeIds.length === 0) {
			const response: DomHoverResponse = { ok: true, matches: 0, hovered: 0 }
			return respondJson(res, response)
		}

		await hoverDomNodes(ctx.cdpSession, nodeIds)
		const response: DomHoverResponse = { ok: true, matches: allNodeIds.length, hovered: nodeIds.length }
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}
