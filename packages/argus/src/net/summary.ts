import type { NetworkRequestSummary } from '@vforsh/argus-core'

const FAILED_LIMIT = 10
const SLOWEST_LIMIT = 5
const LARGEST_LIMIT = 5
const HOST_LIMIT = 5

export type NavigationTimingSummary = {
	type: string | null
	durationMs: number | null
	responseEndMs: number | null
	domInteractiveMs: number | null
	domContentLoadedMs: number | null
	loadEventEndMs: number | null
	transferSize: number | null
	encodedBodySize: number | null
	decodedBodySize: number | null
}

export type NetSummaryReport = {
	totalRequests: number
	statusCounts: Array<{ status: string; count: number }>
	failedCount: number
	failedRequests: NetworkRequestSummary[]
	slowestRequests: NetworkRequestSummary[]
	largestTransfers: NetworkRequestSummary[]
	topHosts: Array<{ host: string; count: number }>
	navigation: NavigationTimingSummary | null
}

export const summarizeNetworkRequests = (
	requests: NetworkRequestSummary[],
	options: { navigation?: NavigationTimingSummary | null } = {},
): NetSummaryReport => {
	const statusCounts = new Map<string, number>()
	const hostCounts = new Map<string, number>()
	const failedRequests: NetworkRequestSummary[] = []

	for (const request of requests) {
		const statusKey = formatStatusKey(request)
		statusCounts.set(statusKey, (statusCounts.get(statusKey) ?? 0) + 1)

		const host = getRequestHost(request.url)
		hostCounts.set(host, (hostCounts.get(host) ?? 0) + 1)

		if (isFailedRequest(request)) {
			failedRequests.push(request)
		}
	}

	return {
		totalRequests: requests.length,
		statusCounts: [...statusCounts.entries()]
			.map(([status, count]) => ({ status, count }))
			.sort((left, right) => right.count - left.count || left.status.localeCompare(right.status)),
		failedCount: failedRequests.length,
		failedRequests: failedRequests.slice(0, FAILED_LIMIT),
		slowestRequests: topRequests(requests, (request) => request.durationMs, SLOWEST_LIMIT),
		largestTransfers: topRequests(requests, (request) => request.encodedDataLength, LARGEST_LIMIT),
		topHosts: [...hostCounts.entries()]
			.map(([host, count]) => ({ host, count }))
			.sort((left, right) => right.count - left.count || left.host.localeCompare(right.host))
			.slice(0, HOST_LIMIT),
		navigation: options.navigation ?? null,
	}
}

export const formatNetSummaryReport = (summary: NetSummaryReport): string[] => {
	const lines = [`Requests: ${summary.totalRequests}`]

	lines.push('Status counts:')
	lines.push(...formatCountLines(summary.statusCounts, ({ status, count }) => `${status}: ${count}`))

	lines.push(`Failed requests: ${summary.failedCount}`)
	lines.push(...formatRequestLines(summary.failedRequests, summary.failedCount, 'failed'))

	lines.push('Slowest requests:')
	lines.push(...formatRequestLines(summary.slowestRequests, summary.slowestRequests.length, 'slowest', { metric: 'duration' }))

	lines.push('Largest transfers:')
	lines.push(...formatRequestLines(summary.largestTransfers, summary.largestTransfers.length, 'largest', { metric: 'size' }))

	lines.push('Top hosts:')
	lines.push(...formatCountLines(summary.topHosts, ({ host, count }) => `${count} ${host}`))

	if (summary.navigation) {
		lines.push('Navigation timing:')
		lines.push(...formatNavigation(summary.navigation))
	}

	return lines
}

const formatCountLines = <T>(items: T[], format: (item: T) => string): string[] =>
	items.length > 0 ? items.map((item) => `  ${format(item)}`) : ['  none']

const formatRequestLines = (
	requests: NetworkRequestSummary[],
	totalCount: number,
	label: 'failed' | 'slowest' | 'largest',
	options: { metric?: 'duration' | 'size' } = {},
): string[] => {
	if (requests.length === 0) {
		return ['  none']
	}

	const lines = requests.map((request) => `  ${formatRequestMetric(request, options.metric)} ${formatRequestCompact(request)}`.trimEnd())
	if (totalCount > requests.length) {
		lines.push(`  ... ${totalCount - requests.length} more ${label}`)
	}
	return lines
}

const formatNavigation = (navigation: NavigationTimingSummary): string[] => {
	const fields = [
		['type', navigation.type],
		['ttfb', formatMs(navigation.responseEndMs)],
		['domInteractive', formatMs(navigation.domInteractiveMs)],
		['domContentLoaded', formatMs(navigation.domContentLoadedMs)],
		['load', formatMs(navigation.loadEventEndMs)],
		['duration', formatMs(navigation.durationMs)],
		['transfer', formatBytes(navigation.transferSize)],
	]
		.filter((entry): entry is [string, string] => entry[1] != null)
		.map(([label, value]) => `${label}: ${value}`)

	return fields.length > 0 ? [`  ${fields.join('  ')}`] : ['  unavailable']
}

const formatRequestMetric = (request: NetworkRequestSummary, metric?: 'duration' | 'size'): string => {
	if (metric === 'duration') {
		return request.durationMs != null ? `${String(request.durationMs).padStart(5)}ms` : '   n/a'
	}
	if (metric === 'size') {
		return request.encodedDataLength != null ? `${(formatBytes(request.encodedDataLength) ?? 'n/a').padStart(8)}` : '     n/a'
	}
	return ''
}

const formatRequestCompact = (request: NetworkRequestSummary): string => {
	const status = formatStatusKey(request)
	const duration = request.durationMs != null ? `${request.durationMs}ms` : 'n/a'
	const size = request.encodedDataLength != null ? formatBytes(request.encodedDataLength) : 'n/a'
	return `${request.method} ${status} ${duration} ${size} ${request.url}`
}

const topRequests = (
	requests: NetworkRequestSummary[],
	getMetric: (request: NetworkRequestSummary) => number | null,
	limit: number,
): NetworkRequestSummary[] =>
	requests
		.filter((request) => getMetric(request) != null)
		.sort((left, right) => {
			const leftMetric = getMetric(left) ?? -1
			const rightMetric = getMetric(right) ?? -1
			return rightMetric - leftMetric || left.id - right.id
		})
		.slice(0, limit)

const isFailedRequest = (request: NetworkRequestSummary): boolean => request.errorText != null || request.status == null || request.status >= 400

const formatStatusKey = (request: NetworkRequestSummary): string => {
	if (request.errorText) {
		return 'ERR'
	}
	return request.status != null ? String(request.status) : 'unknown'
}

const getRequestHost = (url: string): string => {
	try {
		return new URL(url).host || '(unknown)'
	} catch {
		return '(unknown)'
	}
}

const formatMs = (value: number | null): string | null => (value != null ? `${Math.round(value)}ms` : null)

const formatBytes = (value: number | null): string | null => {
	if (value == null) {
		return null
	}
	if (value < 1024) {
		return `${value} B`
	}
	if (value < 1024 * 1024) {
		return `${(value / 1024).toFixed(1)} KB`
	}
	return `${(value / (1024 * 1024)).toFixed(1)} MB`
}
