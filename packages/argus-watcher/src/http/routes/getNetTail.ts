import type { NetTailResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { parseNetRequestFilters, toNetRequestEventQuery, type ParsedNetFilters } from './netFilters.js'
import { respondJson, clampNumber } from '../httpUtils.js'
import type { NetBuffer } from '../../buffer/NetBuffer.js'

export const handle: RouteHandler = async (_req, res, url, ctx) => {
	if (!ctx.netBuffer) {
		return respondJson(res, { ok: false, error: { code: 'net_disabled', message: 'Network capture is disabled for this watcher' } }, 400)
	}

	const parsed = parseTailRequest(url, ctx)
	if (parsed.error || !parsed.value) {
		return respondJson(res, { ok: false, error: { code: 'invalid_net_filter', message: parsed.error ?? 'Invalid network filter' } }, 400)
	}

	const { filters, timeoutMs } = parsed.value
	emitRequest(ctx, res, 'net/tail', toNetRequestEventQuery(filters, { timeoutMs }))

	const requests = await pollNetBuffer(ctx.netBuffer, filters.after, filters, filters.limit, timeoutMs)
	const nextAfter = requests.length > 0 ? (requests[requests.length - 1]?.id ?? filters.after) : filters.after
	const response: NetTailResponse = { ok: true, requests, nextAfter, timedOut: requests.length === 0 }
	respondJson(res, response)
}

const parseTailRequest = (
	url: URL,
	ctx: Parameters<RouteHandler>[3],
): { value?: { filters: ParsedNetFilters; timeoutMs: number }; error?: string } => {
	const filters = parseNetRequestFilters(url.searchParams, {
		after: clampNumber(url.searchParams.get('after'), 0),
		limit: clampNumber(url.searchParams.get('limit'), 500, 1, 5000),
		sinceTs: clampNumber(url.searchParams.get('sinceTs'), undefined),
		context: ctx.getNetFilterContext?.() ?? null,
	})
	if (filters.error || !filters.value) {
		return { error: filters.error ?? 'Invalid network filter' }
	}

	const timeoutMs = clampNumber(url.searchParams.get('timeoutMs'), 25_000, 1000, 120_000)
	return { value: { filters: filters.value, timeoutMs } }
}

const NET_TAIL_POLL_INTERVAL_MS = 100

/**
 * Poll the in-memory buffer until matching requests appear or the timeout expires.
 * This is intentionally boring: network tail has one caller and simple polling proved
 * more reliable than waiter bookkeeping during extension-driven reloads.
 */
const pollNetBuffer = async (
	buffer: NetBuffer,
	after: number,
	filters: ParsedNetFilters,
	limit: number,
	timeoutMs: number,
): Promise<NetTailResponse['requests']> => {
	const deadline = Date.now() + timeoutMs
	while (true) {
		const requests = buffer.listAfter(after, filters, limit)
		if (requests.length > 0) {
			return requests
		}

		const remainingMs = deadline - Date.now()
		if (remainingMs <= 0) {
			return []
		}

		await delay(Math.min(NET_TAIL_POLL_INTERVAL_MS, remainingMs))
	}
}

const delay = (timeoutMs: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, timeoutMs))
