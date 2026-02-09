import type { DomFillRequest, DomFillResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { fillResolvedNodes } from '../../cdp/dom.js'
import { getDomRootId, resolveSelectorMatches, waitForSelectorMatches } from '../../cdp/dom/selector.js'
import { respondJson, respondInvalidBody, respondError, readJsonBody } from '../httpUtils.js'

export const handle: RouteHandler = async (req, res, _url, ctx) => {
	const payload = await readJsonBody<DomFillRequest>(req, res)
	if (!payload) {
		return
	}

	if (!payload.selector || typeof payload.selector !== 'string') {
		return respondInvalidBody(res, 'selector is required')
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
		let allNodeIds: number[]
		let nodeIds: number[]

		if (waitMs > 0) {
			await ctx.cdpSession.sendAndWait('DOM.enable')
			const result = await waitForSelectorMatches(ctx.cdpSession, payload.selector, all, payload.text, waitMs)
			allNodeIds = result.allNodeIds
			nodeIds = result.nodeIds
		} else {
			await ctx.cdpSession.sendAndWait('DOM.enable')
			const rootId = await getDomRootId(ctx.cdpSession)
			const result = await resolveSelectorMatches(ctx.cdpSession, rootId, payload.selector, all, payload.text)
			allNodeIds = result.allNodeIds
			nodeIds = result.nodeIds
		}

		if (!all && allNodeIds.length > 1) {
			return respondJson(
				res,
				{
					ok: false,
					error: {
						message: `Selector matched ${allNodeIds.length} elements; pass all=true to fill all matches`,
						code: 'multiple_matches',
					},
				},
				400,
			)
		}

		const filledCount = await fillResolvedNodes(ctx.cdpSession, nodeIds, payload.value)
		const response: DomFillResponse = { ok: true, matches: allNodeIds.length, filled: filledCount }
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}
