import type { VisibilityRequest } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { readJsonBody, respondInvalidBody, respondJson } from '../httpUtils.js'

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

	// Visibility is a page-level concept; always apply to the top-level page
	// session even when the watcher is iframe-scoped.
	const session = ctx.pageCdpSession
	const response = action === 'show' ? await ctx.visibilityController.show(session) : await ctx.visibilityController.hide(session)

	respondJson(res, response)
}
