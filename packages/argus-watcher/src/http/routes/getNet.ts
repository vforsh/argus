import type { NetResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { parseNetRequestFilters } from './netFilters.js'
import { respondJson, clampNumber } from '../httpUtils.js'

export const handle: RouteHandler = (_req, res, url, ctx) => {
	if (!ctx.netBuffer) {
		return respondJson(res, { ok: false, error: { code: 'net_disabled', message: 'Network capture is disabled for this watcher' } }, 400)
	}

	const filters = parseNetRequestFilters(url.searchParams, {
		after: clampNumber(url.searchParams.get('after'), 0),
		limit: clampNumber(url.searchParams.get('limit'), 500, 1, 5000),
		sinceTs: clampNumber(url.searchParams.get('sinceTs'), undefined),
	})

	emitRequest(ctx, res, 'net', {
		after: filters.after,
		limit: filters.limit,
		sinceTs: filters.sinceTs,
		grep: filters.grep,
		ignoreHosts: filters.ignoreHosts,
		ignorePatterns: filters.ignorePatterns,
	})

	const requests = ctx.netBuffer.listAfter(filters.after, filters, filters.limit)
	const nextAfter = requests.length > 0 ? (requests[requests.length - 1]?.id ?? filters.after) : filters.after
	const response: NetResponse = { ok: true, requests, nextAfter }
	respondJson(res, response)
}
