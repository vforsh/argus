import type { DomNodeHandle } from '../../cdp/dom/selector.js'
import type { WatcherRouteDefinition } from './defineRoute.js'
import type { RouteContext } from './types.js'
import { resolveElementTargets } from '../../cdp/dom/selector.js'
import { respondError, respondJson } from '../httpUtils.js'
import { readDomTargetPayload, respondMissingElementRef, respondMultipleMatches, respondTargetResolutionError } from './domSelectorRoute.js'
import { emitRequest } from './types.js'

/**
 * Body shape required by `defineDomTargetRoute`. Routes that need extra fields
 * (e.g. `wait`, `value`) extend this type.
 */
export type DomTargetRequestBody = {
	selector?: string
	ref?: string
	all?: boolean
	text?: string
}

type DomTargetRouteInput<TBody extends DomTargetRequestBody, TExtra extends object> = {
	method?: 'POST'
	path: string
	/** Endpoint label used by `emitRequest`. */
	endpoint: string
	/**
	 * Verb used in the "Selector matched N elements; pass all=true to {action}…"
	 * error message returned when the request matches more than one node and
	 * `all` is false.
	 */
	action: string
	/**
	 * Run the DOM action against the resolved handles. Receives both the
	 * "filtered" handles (subject to `text`/`all`) and `allHandles` for routes
	 * that want to report total matches separately. Returns the action-specific
	 * fields that go alongside `{ ok, matches }` in the response.
	 *
	 * Called even when `allHandles` is empty (downstream actions are no-ops on
	 * empty arrays) so the route response shape stays consistent.
	 */
	run: (input: { handles: DomNodeHandle[]; allHandles: DomNodeHandle[]; payload: TBody; ctx: RouteContext }) => Promise<TExtra> | TExtra
}

/**
 * Build a `WatcherRouteDefinition` for routes that resolve an element target
 * (selector/ref + text/all) and perform a DOM action.
 *
 * Centralizes the body-parse → emit → resolve → handle multiple/missing
 * → run → respond pipeline shared by hover/focus and similar routes.
 */
export const defineDomTargetRoute = <TBody extends DomTargetRequestBody, TExtra extends object>(
	input: DomTargetRouteInput<TBody, TExtra>,
): WatcherRouteDefinition => ({
	method: input.method ?? 'POST',
	path: input.path,
	handler: async (req, res, _url, ctx) => {
		const parsed = await readDomTargetPayload<TBody>(req, res)
		if (!parsed) return

		const { payload, all } = parsed
		emitRequest(ctx, res, input.endpoint as Parameters<typeof emitRequest>[2])

		try {
			const resolved = await resolveElementTargets(ctx.cdpSession, ctx.elementRefs, {
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
				return respondMultipleMatches(res, allHandles.length, input.action)
			}

			const extra = await input.run({ handles, allHandles, payload, ctx })
			respondJson(res, { ok: true, matches: allHandles.length, ...extra })
		} catch (error) {
			if (respondTargetResolutionError(res, error)) return
			respondError(res, error)
		}
	},
})
