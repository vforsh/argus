import type { DomScrollRequest, DomScrollResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { resolveDomSelectorMatches, scrollDomNodes, scrollViewport } from '../../cdp/mouse.js'
import { respondJson, respondInvalidBody, respondError, readJsonBody } from '../httpUtils.js'

export const handle: RouteHandler = async (req, res, _url, ctx) => {
	const payload = await readJsonBody<DomScrollRequest>(req, res)
	if (!payload) {
		return
	}

	const hasSelector = typeof payload.selector === 'string' && payload.selector.length > 0
	const hasTo = payload.to != null
	const hasBy = payload.by != null

	if (!hasSelector && !hasTo && !hasBy) {
		return respondInvalidBody(res, 'at least one of selector, to, or by is required')
	}

	if (hasTo && hasBy) {
		return respondInvalidBody(res, 'to and by are mutually exclusive')
	}

	if (hasTo) {
		if (
			typeof payload.to!.x !== 'number' ||
			typeof payload.to!.y !== 'number' ||
			!Number.isFinite(payload.to!.x) ||
			!Number.isFinite(payload.to!.y)
		) {
			return respondInvalidBody(res, 'to.x and to.y must be finite numbers')
		}
	}

	if (hasBy) {
		if (
			typeof payload.by!.x !== 'number' ||
			typeof payload.by!.y !== 'number' ||
			!Number.isFinite(payload.by!.x) ||
			!Number.isFinite(payload.by!.y)
		) {
			return respondInvalidBody(res, 'by.x and by.y must be finite numbers')
		}
	}

	const all = payload.all ?? false
	if (typeof all !== 'boolean') {
		return respondInvalidBody(res, 'all must be a boolean')
	}

	emitRequest(ctx, res, 'dom/scroll')

	try {
		const mode = { to: payload.to, by: payload.by }

		// Viewport-only scroll (no selector)
		if (!hasSelector) {
			const { scrollX, scrollY } = await scrollViewport(ctx.cdpSession, mode)
			const response: DomScrollResponse = { ok: true, scrollX, scrollY }
			return respondJson(res, response)
		}

		const { allNodeIds, nodeIds } = await resolveDomSelectorMatches(ctx.cdpSession, payload.selector!, all, payload.text)

		if (!all && allNodeIds.length > 1) {
			return respondJson(
				res,
				{
					ok: false,
					error: {
						message: `Selector matched ${allNodeIds.length} elements; pass all=true to scroll all matches`,
						code: 'multiple_matches',
					},
				},
				400,
			)
		}

		if (allNodeIds.length === 0) {
			const response: DomScrollResponse = { ok: true, matches: 0, scrolled: 0, scrollX: 0, scrollY: 0 }
			return respondJson(res, response)
		}

		const { scrollX, scrollY } = await scrollDomNodes(ctx.cdpSession, nodeIds, mode)
		const response: DomScrollResponse = { ok: true, matches: allNodeIds.length, scrolled: nodeIds.length, scrollX, scrollY }
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}
