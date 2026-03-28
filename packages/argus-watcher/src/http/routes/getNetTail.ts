import type { NetTailResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { parseNetRequestFilters } from './netFilters.js'
import { respondJson, clampNumber } from '../httpUtils.js'

export const handle: RouteHandler = async (_req, res, url, ctx) => {
	if (!ctx.netBuffer) {
		return respondJson(res, { ok: false, error: { code: 'net_disabled', message: 'Network capture is disabled for this watcher' } }, 400)
	}

	const filters = parseNetRequestFilters(url.searchParams, {
		after: clampNumber(url.searchParams.get('after'), 0),
		limit: clampNumber(url.searchParams.get('limit'), 500, 1, 5000),
		sinceTs: clampNumber(url.searchParams.get('sinceTs'), undefined),
	})
	const timeoutMs = clampNumber(url.searchParams.get('timeoutMs'), 25_000, 1000, 120_000)

	emitRequest(ctx, res, 'net/tail', {
		after: filters.after,
		limit: filters.limit,
		sinceTs: filters.sinceTs,
		timeoutMs,
		grep: filters.grep,
		ignoreHosts: filters.ignoreHosts,
		ignorePatterns: filters.ignorePatterns,
	})

	const requests = await ctx.netBuffer.waitForAfter(filters.after, filters, filters.limit, timeoutMs)
	const nextAfter = requests.length > 0 ? (requests[requests.length - 1]?.id ?? filters.after) : filters.after
	const response: NetTailResponse = { ok: true, requests, nextAfter, timedOut: requests.length === 0 }
	respondJson(res, response)
}
