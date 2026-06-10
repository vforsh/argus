import type { NetTailResponse } from '@vforsh/argus-core'
import type { NetBuffer } from '../../buffer/NetBuffer.js'
import type { ParsedNetFilters } from './netFilters.js'
import { defineJsonRoute } from './defineRoute.js'
import { emitRequest } from './types.js'
import { readNetFiltersFromUrl, respondNetDisabled, toNetRequestEventQuery } from './netFilters.js'
import { clampNumber } from '../httpUtils.js'

export const route = defineJsonRoute<undefined, NetTailResponse>({
	method: 'GET',
	path: '/net/tail',
	handle: async ({ res, url, ctx }) => {
		if (!ctx.netBuffer) {
			return respondNetDisabled(res)
		}

		const filters = readNetFiltersFromUrl(url, ctx, res)
		if (!filters) {
			return
		}

		const timeoutMs = clampNumber(url.searchParams.get('timeoutMs'), 25_000, 1000, 120_000)
		emitRequest(ctx, res, 'net/tail', toNetRequestEventQuery(filters, { timeoutMs }))

		const requests = await pollNetBuffer(ctx.netBuffer, filters.after, filters, filters.limit, timeoutMs)
		const nextAfter = requests.length > 0 ? (requests[requests.length - 1]?.id ?? filters.after) : filters.after
		return { ok: true, requests, nextAfter, timedOut: requests.length === 0 }
	},
})

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
