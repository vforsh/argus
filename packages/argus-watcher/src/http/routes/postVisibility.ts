import type { VisibilityLock, VisibilityRequest, VisibilityResponse } from '@vforsh/argus-core'
import { visibilityRequestSchema } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'

export const route = defineJsonRoute<VisibilityRequest, VisibilityResponse>({
	method: 'POST',
	path: '/visibility',
	bodySchema: visibilityRequestSchema,
	endpoint: 'visibility',
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
