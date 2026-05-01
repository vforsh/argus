import type { VisibilityLock, VisibilityRequest, VisibilityResponse } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'
import { emitRequest } from './types.js'
import { respondInvalidBody } from '../httpUtils.js'

export const handle = defineJsonRoute<VisibilityRequest, VisibilityResponse>({
	method: 'POST',
	path: '/visibility',
	parseBody: true,
	handle: async ({ res, ctx, body: payload }) => {
		const action = payload.action
		if (action !== 'show' && action !== 'hide') {
			respondInvalidBody(res, 'Visibility action must be "show" or "hide"')
			return
		}

		emitRequest(ctx, res, 'visibility')
		const lock: VisibilityLock = action === 'show' ? 'shown' : 'default'
		// Visibility is a page-level concept; always apply to the top-level page
		// session even when the watcher is iframe-scoped.
		const session = ctx.pageCdpSession
		const attached = session.isAttached()

		await ctx.visibilityController.setLock(attached ? session : null, lock)

		const response: VisibilityResponse = { ok: true, attached, state: lock }
		return response
	},
}).handler
