import type { NavigateHistoryRequest, NavigateHistoryResponse } from '@vforsh/argus-core'
import { DEFAULT_NAVIGATION_TIMEOUT_MS, DEFAULT_NAVIGATION_WAIT, navigateHistoryRequestSchema } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'
import { navigateHistory } from '../../cdp/navigation.js'

/**
 * Move the attached page through its session history.
 *
 * Driven by CDP in both source modes — `Page.getNavigationHistory` plus
 * `Page.navigateToHistoryEntry` — rather than `chrome.tabs.goBack`, so the two modes share one
 * implementation and the wait sees the same `Page.loadEventFired` either way.
 */
export const route = defineJsonRoute<NavigateHistoryRequest, NavigateHistoryResponse>({
	method: 'POST',
	path: '/navigate/history',
	bodySchema: navigateHistoryRequestSchema,
	endpoint: 'navigate/history',
	handle: async ({ ctx, body: payload }) => {
		const wait = payload.wait ?? DEFAULT_NAVIGATION_WAIT
		const epoch = ctx.buffer.beginLogEpoch()
		const result = await navigateHistory(ctx.pageCdpSession, {
			direction: payload.direction,
			steps: payload.steps ?? 1,
			wait,
			timeoutMs: payload.timeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS,
		})

		return {
			ok: true,
			url: result.url,
			index: result.index,
			length: result.length,
			epoch,
			waited: wait,
		} satisfies NavigateHistoryResponse
	},
})
