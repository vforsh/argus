import type { VisibilityLock, VisibilityRequest, VisibilityResponse } from '@vforsh/argus-core'
import { visibilityRequestSchema } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'
import { respondApiError } from '../httpUtils.js'
import { BACKGROUND_VISIBILITY_RECORDING_MESSAGE } from '../../cdp/capturePolicy.js'

export const route = defineJsonRoute<VisibilityRequest, VisibilityResponse>({
	method: 'POST',
	path: '/visibility',
	bodySchema: visibilityRequestSchema,
	endpoint: 'visibility',
	handle: async ({ ctx, res, body: payload }) => {
		const nextPolicy = payload.policy ?? ctx.visibilityController.getPolicy()
		if (nextPolicy === 'background' && ctx.recorder.status() != null) {
			respondApiError(res, 400, 'not_available', BACKGROUND_VISIBILITY_RECORDING_MESSAGE)
			return
		}

		const lock: VisibilityLock = payload.action === 'show' ? 'shown' : 'default'
		// Visibility is a page-level concept; always apply to the top-level page
		// session even when the watcher is iframe-scoped.
		const session = ctx.pageCdpSession
		const attached = session.isAttached()

		await ctx.visibilityController.setLock(attached ? session : null, lock, payload.policy, payload.activate)

		return { ok: true, attached, state: lock, policy: ctx.visibilityController.getPolicy() }
	},
})
