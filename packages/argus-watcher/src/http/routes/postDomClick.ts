import type { DomClickResponse } from '@vforsh/argus-core'
import { domClickRequestSchema } from '@vforsh/argus-core'
import { respondMissingElementRef, respondMultipleMatches, respondTargetResolutionError } from './domSelectorRoute.js'
import { defineJsonRoute } from './defineRoute.js'
import { clickDomNodes, clickAtPoint, resolveNodePoint } from '../../cdp/mouse.js'
import { resolveElementTargets } from '../../cdp/dom/selector.js'
import { withNavigationWait } from '../../cdp/navigation.js'

export const route = defineJsonRoute({
	method: 'POST',
	path: '/dom/click',
	bodySchema: domClickRequestSchema,
	endpoint: 'dom/click',
	handle: async ({ body: payload, res, ctx }) => {
		const all = payload.all ?? false
		const button = payload.button ?? 'left'
		const waitMs = payload.wait ?? 0
		const hasElementTarget = payload.selector != null || payload.ref != null
		const hasCoords = payload.x != null || payload.y != null

		// The navigation wait is armed around the click itself, never around selector resolution:
		// waiting on the page-scoped session is meaningless until something has actually been clicked.
		const clickWithNav = async (act: () => Promise<void>, matches: number, clicked: number): Promise<DomClickResponse> => {
			const { navigation } = await withNavigationWait(ctx.pageCdpSession, payload, () => ctx.buffer.beginLogEpoch(), act)
			return { ok: true, matches, clicked, navigation }
		}

		if (!hasElementTarget) {
			return await clickWithNav(() => clickAtPoint(ctx.cdpSession, payload.x!, payload.y!, button), 0, 1)
		}

		const resolved = await resolveElementTargets(ctx.cdpSession, ctx.elementRefs, {
			selector: payload.selector,
			ref: payload.ref,
			all,
			text: payload.text,
			waitMs,
		})

		if (resolved.missingRef && payload.ref) {
			respondMissingElementRef(res, payload.ref)
			return
		}

		const { allHandles, handles } = resolved
		if (!all && allHandles.length > 1) {
			respondMultipleMatches(res, allHandles.length, 'click')
			return
		}

		if (allHandles.length === 0) {
			return { ok: true, matches: 0, clicked: 0 } satisfies DomClickResponse
		}

		if (hasCoords) {
			return await clickWithNav(
				async () => {
					for (const handle of handles) {
						const point = await resolveNodePoint(ctx.cdpSession, handle, { x: payload.x!, y: payload.y! })
						await clickAtPoint(ctx.cdpSession, point.x, point.y, button)
					}
				},
				allHandles.length,
				handles.length,
			)
		}

		return await clickWithNav(() => clickDomNodes(ctx.cdpSession, handles, button), allHandles.length, handles.length)
	},
	handleError: respondTargetResolutionError,
})
