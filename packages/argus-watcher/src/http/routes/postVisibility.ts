import type { VisibilityLock, VisibilityRequest, VisibilityResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { readJsonBody, respondError, respondInvalidBody, respondJson } from '../httpUtils.js'

export const handle: RouteHandler = async (req, res, _url, ctx) => {
	const payload = await readJsonBody<VisibilityRequest>(req, res)
	if (!payload) {
		return
	}

	emitRequest(ctx, res, 'visibility')

	const action = payload.action
	if (action !== 'show' && action !== 'hide') {
		respondInvalidBody(res, 'Visibility action must be "show" or "hide"')
		return
	}

	const lock: VisibilityLock = action === 'show' ? 'shown' : 'default'
	// Visibility is a page-level concept; always apply to the top-level page
	// session even when the watcher is iframe-scoped.
	const session = ctx.pageCdpSession
	const attached = session.isAttached()

	try {
		await ctx.visibilityController.setLock(attached ? session : null, lock)
	} catch (error) {
		respondError(res, error)
		return
	}

	const response: VisibilityResponse = { ok: true, attached, state: lock }
	respondJson(res, response)
}
