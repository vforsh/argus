import type { EvalResponse, NetResponse, NetworkRequestSummary } from '@vforsh/argus-core'
import type { NetCliFilterOptions } from './netShared.js'
import { appendNetCommandParams, validateNetCommandOptions } from './netShared.js'
import { filterNetworkRequests } from '../net/requestFilters.js'
import { createOutput } from '../output/io.js'
import { formatWatcherTransportError, fetchWatcherJson, resolveWatcherOrExit } from '../watchers/requestWatcher.js'
import { formatNetSummaryReport, summarizeNetworkRequests, type NavigationTimingSummary } from '../net/summary.js'

const NET_PAGE_LIMIT = 5_000

export type NetSummaryOptions = NetCliFilterOptions & {
	json?: boolean
}

export const runNetSummary = async (id: string | undefined, options: NetSummaryOptions): Promise<void> => {
	const output = createOutput(options)
	const resolved = await resolveWatcherOrExit({ id }, output)
	if (!resolved) {
		return
	}

	const validation = validateNetCommandOptions(options)
	if (validation.error) {
		output.writeWarn(validation.error)
		process.exitCode = 2
		return
	}

	const { watcher } = resolved
	let requests: NetworkRequestSummary[]
	try {
		requests = filterNetworkRequests(await fetchAllRequests(watcher, options), options)
	} catch (error) {
		output.writeWarn(formatWatcherTransportError(watcher, error))
		process.exitCode = 1
		return
	}

	const navigation = await fetchNavigationSummary(watcher).catch(() => null)
	const summary = summarizeNetworkRequests(requests, { navigation })

	if (options.json) {
		output.writeJson(summary)
		return
	}

	for (const line of formatNetSummaryReport(summary)) {
		output.writeHuman(line)
	}
}

const fetchAllRequests = async (watcher: { host: string; port: number }, options: NetCliFilterOptions): Promise<NetworkRequestSummary[]> => {
	const requests: NetworkRequestSummary[] = []
	let after = 0
	const baseParams = new URLSearchParams()
	const baseQuery = appendNetCommandParams(baseParams, options, { includeAfter: false, includeLimit: false })
	if (baseQuery.error) {
		throw new Error(baseQuery.error)
	}

	while (true) {
		const params = new URLSearchParams(baseParams)
		params.set('after', String(after))
		params.set('limit', String(NET_PAGE_LIMIT))

		const response = await fetchWatcherJson<NetResponse>(watcher, {
			path: '/net',
			query: params,
			timeoutMs: 5_000,
		})
		if (response.requests.length === 0) {
			return requests
		}

		requests.push(...response.requests)
		after = response.nextAfter
	}
}

const fetchNavigationSummary = async (watcher: { host: string; port: number }): Promise<NavigationTimingSummary | null> => {
	const response = await fetchWatcherJson<EvalResponse>(watcher, {
		path: '/eval',
		method: 'POST',
		timeoutMs: 5_000,
		body: {
			awaitPromise: true,
			returnByValue: true,
			expression: `(() => {
				const entry = performance.getEntriesByType('navigation')[0]
				if (!entry) return null
				const round = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null)
				return {
					type: typeof entry.type === 'string' ? entry.type : null,
					durationMs: round(entry.duration),
					responseEndMs: round(entry.responseEnd),
					domInteractiveMs: round(entry.domInteractive),
					domContentLoadedMs: round(entry.domContentLoadedEventEnd),
					loadEventEndMs: round(entry.loadEventEnd),
					transferSize: round(entry.transferSize),
					encodedBodySize: round(entry.encodedBodySize),
					decodedBodySize: round(entry.decodedBodySize),
				}
			})()`,
		},
	})

	if (response.exception) {
		return null
	}

	return isNavigationTimingSummary(response.result) ? response.result : null
}

const isNavigationTimingSummary = (value: unknown): value is NavigationTimingSummary => {
	if (!value || typeof value !== 'object') {
		return false
	}
	return 'durationMs' in value || 'responseEndMs' in value || 'type' in value
}
