import type { ReloadRequest, ReloadResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { respondJson, respondError, readJsonBody } from '../httpUtils.js'

export const handle: RouteHandler = async (req, res, _url, ctx) => {
	const payload = await readJsonBody<ReloadRequest>(req, res)
	if (!payload) {
		return
	}

	emitRequest(ctx, res, 'reload')

	try {
		// Reload is page-scoped in CDP, even when the active Argus target is an iframe.
		await ctx.pageCdpSession.sendAndWait('Page.reload', {
			ignoreCache: payload.ignoreCache ?? false,
		})
		const response: ReloadResponse = { ok: true }
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}
