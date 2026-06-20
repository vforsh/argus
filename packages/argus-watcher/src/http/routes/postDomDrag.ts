import type { DomDragResponse } from '@vforsh/argus-core'
import { domDragRequestSchema } from '@vforsh/argus-core'
import { dragAtPoints, dragDomNodes, resolveDragEndPoint } from '../../cdp/mouse.js'
import { resolveElementTargets } from '../../cdp/dom/selector.js'
import { defineJsonRoute } from './defineRoute.js'
import { respondMissingElementRef, respondMultipleMatches, respondTargetResolutionError } from './domSelectorRoute.js'

export const route = defineJsonRoute({
	method: 'POST',
	path: '/dom/drag',
	bodySchema: domDragRequestSchema,
	endpoint: 'dom/drag',
	handle: async ({ body: payload, res, ctx }) => {
		const all = payload.all ?? false
		const waitMs = payload.wait ?? 0
		const hasElementTarget = payload.selector != null || payload.ref != null
		const hasStartOffset = payload.x != null || payload.y != null
		const destination = payload.to ? { to: payload.to } : { delta: payload.delta! }
		const gesture = {
			button: payload.button ?? 'left',
			durationMs: payload.duration ?? 250,
			steps: payload.steps ?? 12,
		}

		if (!hasElementTarget) {
			const start = { x: payload.x!, y: payload.y! }
			await dragAtPoints(ctx.cdpSession, start, resolveDragEndPoint(start, destination), gesture)
			return { ok: true, matches: 0, dragged: 1 } satisfies DomDragResponse
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
			respondMultipleMatches(res, allHandles.length, 'drag')
			return
		}

		if (allHandles.length === 0) {
			return { ok: true, matches: 0, dragged: 0 } satisfies DomDragResponse
		}

		await dragDomNodes(ctx.cdpSession, handles, destination, {
			...gesture,
			offset: hasStartOffset ? { x: payload.x!, y: payload.y! } : undefined,
		})
		return { ok: true, matches: allHandles.length, dragged: handles.length } satisfies DomDragResponse
	},
	handleError: respondTargetResolutionError,
})
