import type { NavigateRequest, NavigateResponse } from '@vforsh/argus-core'
import {
	DEFAULT_NAVIGATION_TIMEOUT_MS,
	DEFAULT_NAVIGATION_WAIT,
	applyQueryParams,
	navigateRequestSchema,
	resolveNavigationUrl,
} from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'
import { navigatePage } from '../../cdp/navigation.js'
import { respondInvalidBody } from '../httpUtils.js'

/**
 * Navigate the attached page.
 *
 * URL resolution happens here rather than in the CLI because the watcher owns the authoritative
 * current URL: `/settings`, `?tab=2`, and a bare `--param` rewrite all need it, and asking for it
 * first would cost a round trip and open a race with whatever else is navigating the page.
 *
 * The log epoch is opened *before* the command is dispatched, so everything the new document
 * logs — including a console line in its first inline script — lands after it.
 */
export const route = defineJsonRoute<NavigateRequest, NavigateResponse>({
	method: 'POST',
	path: '/navigate',
	bodySchema: navigateRequestSchema,
	endpoint: 'navigate',
	handle: async ({ ctx, res, body: payload }) => {
		const currentUrl = ctx.getCdpStatus().target?.url ?? null

		const resolved = payload.url != null ? resolveNavigationUrl(payload.url, currentUrl) : { url: currentUrl ?? '' }
		if ('error' in resolved) {
			return respondInvalidBody(res, resolved.error)
		}
		if (resolved.url === '') {
			return respondInvalidBody(res, 'Cannot rewrite query params: the page has no current URL.')
		}

		const rewritten = applyQueryParams(resolved.url, { param: payload.param, params: payload.params })
		if ('error' in rewritten) {
			return respondInvalidBody(res, rewritten.error)
		}

		const wait = payload.wait ?? DEFAULT_NAVIGATION_WAIT
		// Navigation is page-scoped, like /reload: a selected iframe stays selected across the load.
		const epoch = ctx.buffer.beginLogEpoch()
		const result = await navigatePage(ctx.pageCdpSession, {
			url: rewritten.url,
			wait,
			timeoutMs: payload.timeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS,
		})

		return {
			ok: true,
			requestedUrl: rewritten.url,
			url: result.url,
			loaderId: result.loaderId,
			epoch,
			waited: wait,
		} satisfies NavigateResponse
	},
})
