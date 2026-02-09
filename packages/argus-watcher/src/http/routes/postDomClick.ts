import type { DomClickRequest, DomClickResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { resolveDomSelectorMatches, clickDomNodes, clickAtPoint, resolveNodeTopLeft } from '../../cdp/mouse.js'
import { waitForSelectorMatches } from '../../cdp/dom/selector.js'
import { respondJson, respondInvalidBody, respondError, readJsonBody } from '../httpUtils.js'

export const handle: RouteHandler = async (req, res, _url, ctx) => {
	const payload = await readJsonBody<DomClickRequest>(req, res)
	if (!payload) {
		return
	}

	const hasSelector = typeof payload.selector === 'string' && payload.selector.length > 0
	const hasCoords = payload.x != null || payload.y != null

	if (!hasSelector && !hasCoords) {
		return respondInvalidBody(res, 'selector or x,y coordinates are required')
	}

	if (hasCoords) {
		if (payload.x == null || payload.y == null || !Number.isFinite(payload.x) || !Number.isFinite(payload.y)) {
			return respondInvalidBody(res, 'both x and y must be finite numbers')
		}
	}

	const all = payload.all ?? false
	if (typeof all !== 'boolean') {
		return respondInvalidBody(res, 'all must be a boolean')
	}

	const waitMs = payload.wait ?? 0
	if (typeof waitMs !== 'number' || !Number.isFinite(waitMs) || waitMs < 0) {
		return respondInvalidBody(res, 'wait must be a non-negative number (ms)')
	}

	emitRequest(ctx, res, 'dom/click')

	try {
		// Coordinate-only click (no selector)
		if (!hasSelector) {
			await clickAtPoint(ctx.cdpSession, payload.x!, payload.y!)
			const response: DomClickResponse = { ok: true, matches: 0, clicked: 1 }
			return respondJson(res, response)
		}

		let allNodeIds: number[]
		let nodeIds: number[]

		if (waitMs > 0) {
			await ctx.cdpSession.sendAndWait('DOM.enable')
			const result = await waitForSelectorMatches(ctx.cdpSession, payload.selector!, all, payload.text, waitMs)
			allNodeIds = result.allNodeIds
			nodeIds = result.nodeIds
		} else {
			const result = await resolveDomSelectorMatches(ctx.cdpSession, payload.selector!, all, payload.text)
			allNodeIds = result.allNodeIds
			nodeIds = result.nodeIds
		}

		if (!all && allNodeIds.length > 1) {
			return respondJson(
				res,
				{
					ok: false,
					error: {
						message: `Selector matched ${allNodeIds.length} elements; pass all=true to click all matches`,
						code: 'multiple_matches',
					},
				},
				400,
			)
		}

		if (allNodeIds.length === 0) {
			const response: DomClickResponse = { ok: true, matches: 0, clicked: 0 }
			return respondJson(res, response)
		}

		// Selector + coordinates: click at offset from each element's top-left
		if (hasCoords) {
			for (const nodeId of nodeIds) {
				const topLeft = await resolveNodeTopLeft(ctx.cdpSession, nodeId)
				await clickAtPoint(ctx.cdpSession, topLeft.x + payload.x!, topLeft.y + payload.y!)
			}
			const response: DomClickResponse = { ok: true, matches: allNodeIds.length, clicked: nodeIds.length }
			return respondJson(res, response)
		}

		// Selector only: click element center (existing behavior)
		await clickDomNodes(ctx.cdpSession, nodeIds)
		const response: DomClickResponse = { ok: true, matches: allNodeIds.length, clicked: nodeIds.length }
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}
