import type { NetworkRequestSummary } from '@vforsh/argus-core'
import type { NetCliFilterOptions } from '../commands/netShared.js'
import { parseDurationMs } from '../time.js'

export const filterNetworkRequests = (requests: NetworkRequestSummary[], options: NetCliFilterOptions): NetworkRequestSummary[] => {
	const sinceTs = resolveSinceTimestamp(options.since)
	const grep = options.grep?.trim().toLowerCase() || null
	const ignorePatterns = normalizeList(options.ignorePattern)
	const ignoreHosts = normalizeList(options.ignoreHost)

	return requests.filter((request) => {
		if (sinceTs != null && request.ts < sinceTs) {
			return false
		}

		const url = request.url.toLowerCase()
		if (grep && !url.includes(grep)) {
			return false
		}

		if (ignorePatterns.some((pattern) => url.includes(pattern))) {
			return false
		}

		if (ignoreHosts.length > 0 && matchesIgnoredHost(request.url, ignoreHosts)) {
			return false
		}

		return true
	})
}

const resolveSinceTimestamp = (since?: string): number | null => {
	if (!since) {
		return null
	}

	const durationMs = parseDurationMs(since)
	return durationMs != null ? Date.now() - durationMs : null
}

const normalizeList = (values?: string[]): string[] => values?.map((value) => value.trim().toLowerCase()).filter(Boolean) ?? []

const matchesIgnoredHost = (url: string, ignoreHosts: string[]): boolean => {
	let parsed: URL | null = null
	try {
		parsed = new URL(url)
	} catch {
		parsed = null
	}

	const hostname = parsed?.hostname?.toLowerCase()
	const host = parsed?.host?.toLowerCase()
	return ignoreHosts.some((candidate) => {
		if (!candidate) {
			return false
		}
		if (hostname && (hostname === candidate || hostname.endsWith(`.${candidate}`))) {
			return true
		}
		return host === candidate
	})
}
