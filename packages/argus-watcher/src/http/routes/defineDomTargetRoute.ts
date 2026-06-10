import type { HttpRequestEventMetadata } from '../server.js'
import type { DomNodeHandle } from '../../cdp/dom/selector.js'
import type { WatcherRouteDefinition } from './defineRoute.js'
import type { RouteContext } from './types.js'
import { resolveElementTargets } from '../../cdp/dom/selector.js'
import { defineJsonRoute } from './defineRoute.js'
import { respondMissingElementRef, respondMultipleMatches, respondTargetResolutionError, validateDomTargetBody } from './domSelectorRoute.js'

/**
 * Body shape required by `defineDomTargetRoute`. Routes that need extra fields
 * (e.g. `value`) extend this type.
 */
export type DomTargetRequestBody = {
	selector?: string
	ref?: string
	all?: boolean
	text?: string
	/** Optional bounded wait (ms) for the selector to match before resolving. */
	wait?: number
}

type DomTargetRouteInput<TBody extends DomTargetRequestBody, TExtra extends object> = {
	method?: 'POST'
	path: string
	/** Endpoint label used by `emitRequest`. */
	endpoint: HttpRequestEventMetadata['endpoint']
	/**
	 * Verb used in the "Selector matched N elements; pass all=true to {action}…"
	 * error message returned when the request matches more than one node and
	 * `all` is false.
	 */
	action: string
	/**
	 * Extra body validation, run after the shared selector/ref/all checks.
	 * Returns an error message to respond 400 `invalid_request`, or null.
	 */
	validate?: (payload: TBody) => string | null
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
 * (selector/ref + text/all/wait) and perform a DOM action.
 *
 * Centralizes the body-parse → validate → emit → resolve → handle
 * multiple/missing → run → respond pipeline shared by hover/focus/fill and
 * similar routes.
 */
export const defineDomTargetRoute = <TBody extends DomTargetRequestBody, TExtra extends object>(
	input: DomTargetRouteInput<TBody, TExtra>,
): WatcherRouteDefinition =>
	defineJsonRoute<TBody, { ok: true; matches: number } & TExtra>({
		method: input.method ?? 'POST',
		path: input.path,
		parseBody: true,
		endpoint: input.endpoint,
		validate: (payload) => validateDomTargetBody(payload) ?? input.validate?.(payload) ?? null,
		handle: async ({ res, ctx, body: payload }) => {
			const all = payload.all ?? false
			const resolved = await resolveElementTargets(ctx.cdpSession, ctx.elementRefs, {
				selector: payload.selector,
				ref: payload.ref,
				all,
				text: payload.text,
				waitMs: payload.wait,
			})
			if (resolved.missingRef && payload.ref) {
				return respondMissingElementRef(res, payload.ref)
			}

			const { allHandles, handles } = resolved
			if (!all && allHandles.length > 1) {
				return respondMultipleMatches(res, allHandles.length, input.action)
			}

			const extra = await input.run({ handles, allHandles, payload, ctx })
			return { ok: true, matches: allHandles.length, ...extra }
		},
		handleError: respondTargetResolutionError,
	})
