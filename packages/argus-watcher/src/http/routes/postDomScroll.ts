import { evaluateInPage } from '../../cdp/pageState.js'
import type { DomScrollRequest, DomScrollResponse } from '@vforsh/argus-core'
import { domScrollRequestSchema } from '@vforsh/argus-core'
import type { CdpSessionHandle } from '../../cdp/connection.js'
import { resolveDomSelectorMatches, emulateScroll, emulateScrollOnNodes } from '../../cdp/mouse.js'
import { defineJsonRoute } from './defineRoute.js'
import { respondMultipleMatches } from './domSelectorRoute.js'

export const route = defineJsonRoute<DomScrollRequest, DomScrollResponse>({
	method: 'POST',
	path: '/dom/scroll',
	bodySchema: domScrollRequestSchema,
	endpoint: 'dom/scroll',
	handle: async ({ res, ctx, body: payload }) => {
		const all = payload.all ?? false
		const hasSelector = typeof payload.selector === 'string' && payload.selector.length > 0
		const hasPos = payload.x != null || payload.y != null

		// Coordinate-based scroll
		if (hasPos) {
			await emulateScroll(ctx.cdpSession, payload.x!, payload.y!, payload.delta)
			return { ok: true }
		}

		// Viewport-center scroll (no selector, no pos)
		if (!hasSelector) {
			const { width, height } = await getViewportSize(ctx.cdpSession)
			await emulateScroll(ctx.cdpSession, Math.round(width / 2), Math.round(height / 2), payload.delta)
			return { ok: true }
		}

		// Selector-based scroll
		const { allNodeIds, nodeIds } = await resolveDomSelectorMatches(ctx.cdpSession, payload.selector!, all, payload.text)

		if (!all && allNodeIds.length > 1) {
			return respondMultipleMatches(res, allNodeIds.length, 'scroll')
		}

		if (allNodeIds.length === 0) {
			return { ok: true, matches: 0, scrolled: 0 }
		}

		await emulateScrollOnNodes(
			ctx.cdpSession,
			nodeIds.map((nodeId) => ({ nodeId })),
			payload.delta,
		)
		return { ok: true, matches: allNodeIds.length, scrolled: nodeIds.length }
	},
})

const getViewportSize = async (session: CdpSessionHandle): Promise<{ width: number; height: number }> => {
	const serialized = await evaluateInPage<string | undefined>(session, 'JSON.stringify({width:window.innerWidth,height:window.innerHeight})')
	const parsed: { width: number; height: number } = serialized ? JSON.parse(serialized) : { width: 800, height: 600 }
	return { width: parsed.width, height: parsed.height }
}
