import type { NetClearResponse, NetResponse, NetTailResponse, ReloadResponse } from '@vforsh/argus-core'
import type { NetCliFilterOptions } from './netShared.js'
import { appendNetCommandParams, parseNetDurationMs, parseSettleDurationMs, validateNetCommandOptions } from './netShared.js'
import { fetchWatcherJson, formatWatcherTransportError, resolveWatcherOrExit } from '../watchers/requestWatcher.js'
import { createOutput } from '../output/io.js'
import { formatNetworkRequest } from '../output/net.js'

export type NetWatchOptions = NetCliFilterOptions & {
	json?: boolean
	reload?: boolean
	clear?: boolean
	settle?: string
	ignoreCache?: boolean
	maxTimeout?: string
}

export const runNetWatch = async (id: string | undefined, options: NetWatchOptions): Promise<void> => {
	const output = createOutput(options)
	const resolved = await resolveWatcherOrExit({ id }, output)
	if (!resolved) {
		return
	}

	const parsed = parseNetWatchArgs(options)
	if (parsed.error || !parsed.value) {
		output.writeWarn(parsed.error ?? 'Invalid net watch options.')
		process.exitCode = 2
		return
	}

	const { watcher } = resolved
	const clearBeforeWatch = options.clear ?? true
	let cleared = 0
	let requests: NetResponse['requests']
	let timedOut = false
	try {
		if (clearBeforeWatch) {
			const response = await fetchWatcherJson<NetClearResponse>(watcher, {
				path: '/net/clear',
				method: 'POST',
				timeoutMs: 5_000,
			})
			cleared = response.cleared
		}

		if (options.reload) {
			await fetchWatcherJson<ReloadResponse>(watcher, {
				path: '/reload',
				method: 'POST',
				body: { ignoreCache: options.ignoreCache ?? false },
				timeoutMs: 10_000,
			})
		}

		const settled = await waitForNetworkToSettle(watcher, options, parsed.value.settleMs, parsed.value.maxTimeoutMs)
		requests = settled.requests
		timedOut = settled.timedOut
	} catch (error) {
		output.writeWarn(formatWatcherTransportError(watcher, error))
		process.exitCode = 1
		return
	}

	if (options.json) {
		output.writeJson({
			ok: true,
			cleared,
			reloaded: options.reload === true,
			settleMs: parsed.value.settleMs,
			timedOut,
			requests,
			nextAfter: requests[requests.length - 1]?.id ?? 0,
		})
		return
	}

	if (requests.length === 0) {
		output.writeHuman(`no requests captured after ${parsed.value.settleMs}ms quiet window`)
		return
	}

	for (const request of requests) {
		output.writeHuman(formatNetworkRequest(request))
	}
	output.writeHuman(
		timedOut
			? `stopped after max timeout (${requests.length} requests collected; quiet window ${parsed.value.settleMs}ms not reached)`
			: `settled after ${parsed.value.settleMs}ms quiet window (${requests.length} requests)`,
	)
}

const WATCH_BATCH_LIMIT = 5_000

const parseNetWatchArgs = (options: NetWatchOptions): { value?: { settleMs: number; maxTimeoutMs?: number }; error?: string } => {
	const settle = parseSettleDurationMs(options.settle)
	if (settle.error || settle.value == null) {
		return { error: settle.error ?? 'Invalid --settle value.' }
	}

	const maxTimeout = parseNetDurationMs(options.maxTimeout, '--max-timeout')
	if (maxTimeout.error) {
		return { error: maxTimeout.error }
	}

	const validation = validateNetCommandOptions(options)
	if (validation.error) {
		return { error: validation.error }
	}

	return {
		value: {
			settleMs: settle.value,
			maxTimeoutMs: maxTimeout.value,
		},
	}
}

/** Keep tailing matching requests until the watcher stays quiet for `settleMs`. */
const waitForNetworkToSettle = async (
	watcher: { host: string; port: number },
	options: NetCliFilterOptions,
	settleMs: number,
	maxTimeoutMs?: number,
): Promise<{ requests: NetResponse['requests']; timedOut: boolean }> => {
	const requests: NetResponse['requests'] = []
	let after = 0
	const startedAt = Date.now()

	while (true) {
		const remaining = maxTimeoutMs != null ? maxTimeoutMs - (Date.now() - startedAt) : null
		if (remaining != null && remaining <= 0) {
			return { requests, timedOut: true }
		}

		const timeoutMs = remaining != null ? Math.min(settleMs, remaining) : settleMs
		const params = createNetTailParams(options, after, timeoutMs)
		const response = await fetchWatcherJson<NetTailResponse>(watcher, {
			path: '/net/tail',
			query: params,
			timeoutMs: timeoutMs + 5_000,
		})

		if (response.requests.length === 0) {
			return { requests, timedOut: maxTimeoutMs != null && timeoutMs < settleMs }
		}

		requests.push(...response.requests)
		after = response.nextAfter
	}
}

const createNetTailParams = (options: NetCliFilterOptions, after: number, timeoutMs: number): URLSearchParams => {
	const params = new URLSearchParams()
	params.set('after', String(after))
	params.set('limit', String(WATCH_BATCH_LIMIT))
	params.set('timeoutMs', String(timeoutMs))

	const query = appendNetCommandParams(params, { ...options, after: String(after), limit: String(WATCH_BATCH_LIMIT) }, { includeAfter: false })
	if (query.error) {
		throw new Error(query.error)
	}

	return params
}
