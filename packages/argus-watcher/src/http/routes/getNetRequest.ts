import type { NetRequestResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { respondJson } from '../httpUtils.js'
import { parseNetRequestLookup, resolveNetRequestLookup } from './netRequestLookup.js'

export const handle: RouteHandler = (_req, res, url, ctx) => {
	if (!ctx.netBuffer) {
		return respondJson(res, { ok: false, error: { code: 'net_disabled', message: 'Network capture is disabled for this watcher' } }, 400)
	}

	const lookup = parseNetRequestLookup(url.searchParams)
	if (!lookup) {
		return respondJson(res, { ok: false, error: { code: 'invalid_request', message: 'Either id or requestId is required' } }, 400)
	}

	emitRequest(ctx, res, 'net/request', {
		id: lookup.id,
		requestId: lookup.requestId,
	})

	const request = resolveNetRequestLookup(ctx.netBuffer, lookup)
	if (!request) {
		return respondJson(res, { ok: false, error: { code: 'not_found', message: 'Network request not found' } }, 404)
	}

	const response: NetRequestResponse = { ok: true, request }
	respondJson(res, response)
}
