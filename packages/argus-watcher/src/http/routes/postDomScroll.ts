import type { DomScrollRequest, DomScrollResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { resolveDomSelectorMatches, emulateScroll, emulateScrollOnNodes } from '../../cdp/mouse.js'
import { respondJson, respondInvalidBody, respondError, readJsonBody } from '../httpUtils.js'

export const handle: RouteHandler = async (req, res, _url, ctx) => {
	const payload = await readJsonBody<DomScrollRequest>(req, res)
	if (!payload) {
		return
	}

	if (payload.delta == null || typeof payload.delta.x !== 'number' || typeof payload.delta.y !== 'number') {
		return respondInvalidBody(res, 'delta is required with { x, y } numbers')
	}

	if (!Number.isFinite(payload.delta.x) || !Number.isFinite(payload.delta.y)) {
		return respondInvalidBody(res, 'delta.x and delta.y must be finite numbers')
	}

	const hasSelector = typeof payload.selector === 'string' && payload.selector.length > 0
	const hasPos = payload.x != null || payload.y != null

	if (hasSelector && hasPos) {
		return respondInvalidBody(res, 'selector and x/y coordinates are mutually exclusive')
	}

	if (hasPos) {
		if (typeof payload.x !== 'number' || typeof payload.y !== 'number' || !Number.isFinite(payload.x) || !Number.isFinite(payload.y)) {
			return respondInvalidBody(res, 'x and y must both be finite numbers')
		}
	}

	const all = payload.all ?? false
	if (typeof all !== 'boolean') {
		return respondInvalidBody(res, 'all must be a boolean')
	}

	emitRequest(ctx, res, 'dom/scroll')

	try {
		// Coordinate-based scroll
		if (hasPos) {
			await emulateScroll(ctx.cdpSession, payload.x!, payload.y!, payload.delta)
			const response: DomScrollResponse = { ok: true }
			return respondJson(res, response)
		}

		// Viewport-center scroll (no selector, no pos)
		if (!hasSelector) {
			const { width, height } = await getViewportSize(ctx.cdpSession)
			await emulateScroll(ctx.cdpSession, Math.round(width / 2), Math.round(height / 2), payload.delta)
			const response: DomScrollResponse = { ok: true }
			return respondJson(res, response)
		}

		// Selector-based scroll
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
			const response: DomScrollResponse = { ok: true, matches: 0, scrolled: 0 }
			return respondJson(res, response)
		}

		await emulateScrollOnNodes(ctx.cdpSession, nodeIds, payload.delta)
		const response: DomScrollResponse = { ok: true, matches: allNodeIds.length, scrolled: nodeIds.length }
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}

const getViewportSize = async (session: import('../../cdp/connection.js').CdpSessionHandle): Promise<{ width: number; height: number }> => {
	const result = (await session.sendAndWait('Runtime.evaluate', {
		expression: 'JSON.stringify({width:window.innerWidth,height:window.innerHeight})',
		returnByValue: true,
	})) as { result?: { value?: string } }

	const parsed = result.result?.value ? JSON.parse(result.result.value) : { width: 800, height: 600 }
	return { width: parsed.width, height: parsed.height }
}
