import type { DomClickRequest, DomClickResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { respondMissingElementRef, respondMultipleMatches, respondTargetResolutionError } from './domSelectorRoute.js'
import { emitRequest } from './types.js'
import { clickDomNodes, clickAtPoint, resolveNodeTopLeft } from '../../cdp/mouse.js'
import { resolveElementTargets } from '../../cdp/dom/selector.js'
import { respondJson, respondInvalidBody, respondError, readJsonBody } from '../httpUtils.js'

export const handle: RouteHandler = async (req, res, _url, ctx) => {
	const payload = await readJsonBody<DomClickRequest>(req, res)
	if (!payload) {
		return
	}

	const hasSelector = typeof payload.selector === 'string' && payload.selector.length > 0
	const hasRef = typeof payload.ref === 'string' && payload.ref.length > 0
	const hasCoords = payload.x != null || payload.y != null

	if (!hasSelector && !hasRef && !hasCoords) {
		return respondInvalidBody(res, 'selector, ref, or x,y coordinates are required')
	}

	if (hasSelector && hasRef) {
		return respondInvalidBody(res, 'selector and ref are mutually exclusive')
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

	const validButtons = ['left', 'middle', 'right']
	const button = payload.button ?? 'left'
	if (!validButtons.includes(button)) {
		return respondInvalidBody(res, `button must be one of: ${validButtons.join(', ')}`)
	}

	const waitMs = payload.wait ?? 0
	if (typeof waitMs !== 'number' || !Number.isFinite(waitMs) || waitMs < 0) {
		return respondInvalidBody(res, 'wait must be a non-negative number (ms)')
	}

	emitRequest(ctx, res, 'dom/click')

	try {
		// Coordinate-only click (no selector/ref)
		if (!hasSelector && !hasRef) {
			await clickAtPoint(ctx.cdpSession, payload.x!, payload.y!, button)
			const response: DomClickResponse = { ok: true, matches: 0, clicked: 1 }
			return respondJson(res, response)
		}

		const resolved =
			waitMs > 0
				? await resolveElementTargets(ctx.cdpSession, ctx.elementRefs, {
						selector: payload.selector,
						ref: payload.ref,
						all,
						text: payload.text,
						waitMs,
					})
				: await resolveElementTargets(ctx.cdpSession, ctx.elementRefs, {
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
			return respondMultipleMatches(res, allHandles.length, 'click')
		}

		if (allHandles.length === 0) {
			const response: DomClickResponse = { ok: true, matches: 0, clicked: 0 }
			return respondJson(res, response)
		}

		// Selector + coordinates: click at offset from each element's top-left
		if (hasCoords) {
			for (const handle of handles) {
				const topLeft = await resolveNodeTopLeft(ctx.cdpSession, handle)
				await clickAtPoint(ctx.cdpSession, topLeft.x + payload.x!, topLeft.y + payload.y!, button)
			}
			const response: DomClickResponse = { ok: true, matches: allHandles.length, clicked: handles.length }
			return respondJson(res, response)
		}

		// Selector only: click element center (existing behavior)
		await clickDomNodes(ctx.cdpSession, handles, button)
		const response: DomClickResponse = { ok: true, matches: allHandles.length, clicked: handles.length }
		respondJson(res, response)
	} catch (error) {
		if (respondTargetResolutionError(res, error)) {
			return
		}
		respondError(res, error)
	}
}
