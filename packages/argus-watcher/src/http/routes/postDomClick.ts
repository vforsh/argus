import type { DomClickResponse } from '@vforsh/argus-core'
import { domClickRequestSchema } from '@vforsh/argus-core'
import { respondMissingElementRef, respondMultipleMatches, respondTargetResolutionError } from './domSelectorRoute.js'
import { defineJsonRoute } from './defineRoute.js'
import { clickDomNodes, clickAtPoint, resolveNodeTopLeft } from '../../cdp/mouse.js'
import { resolveElementTargets } from '../../cdp/dom/selector.js'

export const route = defineJsonRoute({
	method: 'POST',
	path: '/dom/click',
	bodySchema: domClickRequestSchema,
	endpoint: 'dom/click',
	handle: async ({ body: payload, res, ctx }) => {
		const all = payload.all ?? false
		const button = payload.button ?? 'left'
		const waitMs = payload.wait ?? 0
		const hasSelector = payload.selector != null
		const hasRef = payload.ref != null
		const hasCoords = payload.x != null || payload.y != null

		if (!hasSelector && !hasRef) {
			await clickAtPoint(ctx.cdpSession, payload.x!, payload.y!, button)
			return { ok: true, matches: 0, clicked: 1 } satisfies DomClickResponse
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
			for (const handle of handles) {
				const topLeft = await resolveNodeTopLeft(ctx.cdpSession, handle)
				await clickAtPoint(ctx.cdpSession, topLeft.x + payload.x!, topLeft.y + payload.y!, button)
			}
			return { ok: true, matches: allHandles.length, clicked: handles.length } satisfies DomClickResponse
		}

		await clickDomNodes(ctx.cdpSession, handles, button)
		return { ok: true, matches: allHandles.length, clicked: handles.length } satisfies DomClickResponse
	},
	handleError: respondTargetResolutionError,
})

export const handle = route.handler
