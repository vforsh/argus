import type { DomScrollToRequest, DomScrollToResponse } from '@vforsh/argus-core'
import { resolveDomSelectorMatches, scrollDomNodes, scrollViewport } from '../../cdp/mouse.js'
import { defineJsonRoute } from './defineRoute.js'
import { respondMultipleMatches } from './domSelectorRoute.js'

export const route = defineJsonRoute<DomScrollToRequest, DomScrollToResponse>({
	method: 'POST',
	path: '/dom/scroll-to',
	parseBody: true,
	endpoint: 'dom/scroll-to',
	validate: (payload) => {
		const hasSelector = typeof payload.selector === 'string' && payload.selector.length > 0
		const hasTo = payload.to != null
		const hasBy = payload.by != null

		if (!hasSelector && !hasTo && !hasBy) {
			return 'at least one of selector, to, or by is required'
		}
		if (hasTo && hasBy) {
			return 'to and by are mutually exclusive'
		}
		if (
			hasTo &&
			(typeof payload.to!.x !== 'number' ||
				typeof payload.to!.y !== 'number' ||
				!Number.isFinite(payload.to!.x) ||
				!Number.isFinite(payload.to!.y))
		) {
			return 'to.x and to.y must be finite numbers'
		}
		if (
			hasBy &&
			(typeof payload.by!.x !== 'number' ||
				typeof payload.by!.y !== 'number' ||
				!Number.isFinite(payload.by!.x) ||
				!Number.isFinite(payload.by!.y))
		) {
			return 'by.x and by.y must be finite numbers'
		}
		if (typeof (payload.all ?? false) !== 'boolean') {
			return 'all must be a boolean'
		}
		return null
	},
	handle: async ({ res, ctx, body: payload }) => {
		const all = payload.all ?? false
		const hasSelector = typeof payload.selector === 'string' && payload.selector.length > 0
		const mode = { to: payload.to, by: payload.by }

		// Viewport-only scroll (no selector)
		if (!hasSelector) {
			const { scrollX, scrollY } = await scrollViewport(ctx.cdpSession, mode)
			return { ok: true, scrollX, scrollY }
		}

		const { allNodeIds, nodeIds } = await resolveDomSelectorMatches(ctx.cdpSession, payload.selector!, all, payload.text)

		if (!all && allNodeIds.length > 1) {
			return respondMultipleMatches(res, allNodeIds.length, 'scroll')
		}

		if (allNodeIds.length === 0) {
			return { ok: true, matches: 0, scrolled: 0, scrollX: 0, scrollY: 0 }
		}

		const { scrollX, scrollY } = await scrollDomNodes(
			ctx.cdpSession,
			nodeIds.map((nodeId) => ({ nodeId })),
			mode,
		)
		return { ok: true, matches: allNodeIds.length, scrolled: nodeIds.length, scrollX, scrollY }
	},
})
