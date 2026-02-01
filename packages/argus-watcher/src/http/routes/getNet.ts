import type { NetResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { respondJson, clampNumber, normalizeQueryValue } from '../httpUtils.js'

export const handle: RouteHandler = (_req, res, url, ctx) => {
	if (!ctx.netBuffer) {
		return respondJson(res, { ok: false, error: { code: 'net_disabled', message: 'Network capture is disabled for this watcher' } }, 400)
	}

	const after = clampNumber(url.searchParams.get('after'), 0)
	const limit = clampNumber(url.searchParams.get('limit'), 500, 1, 5000)
	const sinceTs = clampNumber(url.searchParams.get('sinceTs'), undefined)
	const grep = normalizeQueryValue(url.searchParams.get('grep'))

	emitRequest(ctx, res, 'net', { after, limit, sinceTs, grep })

	const requests = ctx.netBuffer.listAfter(after, { sinceTs, grep }, limit)
	const nextAfter = requests.length > 0 ? (requests[requests.length - 1]?.id ?? after) : after
	const response: NetResponse = { ok: true, requests, nextAfter }
	respondJson(res, response)
}
