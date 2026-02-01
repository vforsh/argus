import type { NetTailResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { respondJson, clampNumber, normalizeQueryValue } from '../httpUtils.js'

export const handle: RouteHandler = async (_req, res, url, ctx) => {
	if (!ctx.netBuffer) {
		return respondJson(res, { ok: false, error: { code: 'net_disabled', message: 'Network capture is disabled for this watcher' } }, 400)
	}

	const after = clampNumber(url.searchParams.get('after'), 0)
	const limit = clampNumber(url.searchParams.get('limit'), 500, 1, 5000)
	const timeoutMs = clampNumber(url.searchParams.get('timeoutMs'), 25_000, 1000, 120_000)
	const sinceTs = clampNumber(url.searchParams.get('sinceTs'), undefined)
	const grep = normalizeQueryValue(url.searchParams.get('grep'))

	emitRequest(ctx, res, 'net/tail', { after, limit, sinceTs, timeoutMs, grep })

	const requests = await ctx.netBuffer.waitForAfter(after, { sinceTs, grep }, limit, timeoutMs)
	const nextAfter = requests.length > 0 ? (requests[requests.length - 1]?.id ?? after) : after
	const response: NetTailResponse = { ok: true, requests, nextAfter, timedOut: requests.length === 0 }
	respondJson(res, response)
}
