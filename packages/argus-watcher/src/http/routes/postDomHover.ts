import type { DomHoverRequest, DomHoverResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { resolveDomSelectorMatches, hoverDomNodes } from '../../cdp/mouse.js'
import { respondJson, respondInvalidBody, respondError, readJsonBody } from '../httpUtils.js'

export const handle: RouteHandler = async (req, res, _url, ctx) => {
	const payload = await readJsonBody<DomHoverRequest>(req, res)
	if (!payload) {
		return
	}

	if (!payload.selector || typeof payload.selector !== 'string') {
		return respondInvalidBody(res, 'selector is required')
	}

	const all = payload.all ?? false
	if (typeof all !== 'boolean') {
		return respondInvalidBody(res, 'all must be a boolean')
	}

	emitRequest(ctx, res, 'dom/hover')

	try {
		const { allNodeIds, nodeIds } = await resolveDomSelectorMatches(ctx.cdpSession, payload.selector, all, payload.text)

		if (!all && allNodeIds.length > 1) {
			return respondJson(
				res,
				{
					ok: false,
					error: {
						message: `Selector matched ${allNodeIds.length} elements; pass all=true to hover all matches`,
						code: 'multiple_matches',
					},
				},
				400,
			)
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
