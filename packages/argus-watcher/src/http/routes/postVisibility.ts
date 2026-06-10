import type { VisibilityLock, VisibilityRequest, VisibilityResponse } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'

export const route = defineJsonRoute<VisibilityRequest, VisibilityResponse>({
	method: 'POST',
	path: '/visibility',
	parseBody: true,
	endpoint: 'visibility',
	validate: (payload) => {
		if (payload.action !== 'show' && payload.action !== 'hide') {
			return 'Visibility action must be "show" or "hide"'
		}
		return null
	},
	handle: async ({ ctx, body: payload }) => {
		const lock: VisibilityLock = payload.action === 'show' ? 'shown' : 'default'
		// Visibility is a page-level concept; always apply to the top-level page
		// session even when the watcher is iframe-scoped.
		const session = ctx.pageCdpSession
		const attached = session.isAttached()

		await ctx.visibilityController.setLock(attached ? session : null, lock)

		return { ok: true, attached, state: lock }
	},
})
