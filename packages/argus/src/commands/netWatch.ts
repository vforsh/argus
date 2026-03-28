import type { NetClearResponse, NetResponse, ReloadResponse } from '@vforsh/argus-core'
import type { NetCliFilterOptions } from './netShared.js'
import { appendNetCommandParams, parseSettleDurationMs, validateNetCommandOptions } from './netShared.js'
import { fetchWatcherJson, formatWatcherTransportError, resolveWatcherOrExit } from '../watchers/requestWatcher.js'
import { filterNetworkRequests } from '../net/requestFilters.js'
import { createOutput } from '../output/io.js'
import { formatNetworkRequest } from '../output/format.js'

const WATCH_BATCH_LIMIT = 5_000

export type NetWatchOptions = NetCliFilterOptions & {
	json?: boolean
	reload?: boolean
	clear?: boolean
	settle?: string
	ignoreCache?: boolean
}

export const runNetWatch = async (id: string | undefined, options: NetWatchOptions): Promise<void> => {
	const output = createOutput(options)
	const resolved = await resolveWatcherOrExit({ id }, output)
	if (!resolved) {
		return
	}

	const settle = parseSettleDurationMs(options.settle)
	if (settle.error || settle.value == null) {
		output.writeWarn(settle.error ?? 'Invalid --settle value.')
		process.exitCode = 2
		return
	}

	const validation = validateNetCommandOptions(options)
	if (validation.error) {
		output.writeWarn(validation.error)
		process.exitCode = 2
		return
	}

	const { watcher } = resolved
	const clearBeforeWatch = options.clear ?? true
	let cleared = 0
	let requests: NetResponse['requests']
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

		await wait(settle.value)
		requests = await fetchWatchedRequests(watcher, options)
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
			settleMs: settle.value,
			requests,
			nextAfter: requests[requests.length - 1]?.id ?? 0,
		})
		return
	}

	if (requests.length === 0) {
		output.writeHuman(`no requests captured after ${settle.value}ms quiet window`)
		return
	}

	for (const request of requests) {
		output.writeHuman(formatNetworkRequest(request))
	}
	output.writeHuman(`settled after ${settle.value}ms quiet window (${requests.length} requests)`)
}

const fetchWatchedRequests = async (watcher: { host: string; port: number }, options: NetCliFilterOptions): Promise<NetResponse['requests']> => {
	const params = new URLSearchParams()
	params.set('limit', String(WATCH_BATCH_LIMIT))
	const query = appendNetCommandParams(params, { limit: String(WATCH_BATCH_LIMIT) }, { includeAfter: false })
	if (query.error) {
		throw new Error(query.error)
	}

	const response = await fetchWatcherJson<NetResponse>(watcher, {
		path: '/net',
		query: params,
		timeoutMs: 5_000,
	})
	return filterNetworkRequests(response.requests, options)
}

const wait = async (ms: number): Promise<void> => {
	await new Promise((resolve) => setTimeout(resolve, ms))
}
