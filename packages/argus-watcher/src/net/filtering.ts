import type { NetworkRequestSummary } from '@vforsh/argus-core'

export type NetParty = 'first' | 'third'

export type NetScope = 'selected' | 'page' | 'tab'

export type NetFilterContext = {
	sourceMode: 'cdp' | 'extension'
	selectedFrameId: string | null
	topFrameId: string | null
	selectedTargetUrl: string | null
	pageUrl: string | null
}

export type NetFilters = {
	grep?: string
	sinceTs?: number
	ignoreHosts?: string[]
	ignorePatterns?: string[]
	hosts?: string[]
	methods?: string[]
	statuses?: string[]
	resourceTypes?: string[]
	mimeTypes?: string[]
	party?: NetParty
	partyHost?: string | null
	frameId?: string
	documentUrlKey?: string | null
	failedOnly?: boolean
	minDurationMs?: number
	minTransferBytes?: number
}

export const matchesNetFilters = (event: NetworkRequestSummary, filters: NetFilters): boolean => {
	if (filters.sinceTs && event.ts < filters.sinceTs) {
		return false
	}

	const haystack = event.url.toLowerCase()

	if (filters.grep && !haystack.includes(filters.grep.toLowerCase())) {
		return false
	}

	if (filters.ignorePatterns && filters.ignorePatterns.some((pattern) => haystack.includes(pattern.toLowerCase()))) {
		return false
	}

	if (filters.ignoreHosts?.length && matchesHostList(event.url, filters.ignoreHosts)) {
		return false
	}

	if (filters.hosts?.length && !matchesHostList(event.url, filters.hosts)) {
		return false
	}

	if (filters.methods?.length) {
		const method = event.method.toLowerCase()
		if (!filters.methods.some((candidate) => candidate.toLowerCase() === method)) {
			return false
		}
	}

	if (filters.statuses?.length && !matchesStatusFilter(event.status, filters.statuses)) {
		return false
	}

	if (filters.resourceTypes?.length) {
		const resourceType = event.resourceType?.toLowerCase()
		if (!resourceType || !filters.resourceTypes.some((candidate) => candidate.toLowerCase() === resourceType)) {
			return false
		}
	}

	if (filters.mimeTypes?.length) {
		const mimeType = event.mimeType?.toLowerCase()
		if (!mimeType || !filters.mimeTypes.some((candidate) => mimeType.startsWith(candidate.toLowerCase()))) {
			return false
		}
	}

	if (!matchesFrameFilter(event, filters)) {
		return false
	}

	if (filters.failedOnly && !isFailedRequest(event)) {
		return false
	}

	if (filters.minDurationMs != null && (event.durationMs == null || event.durationMs < filters.minDurationMs)) {
		return false
	}

	if (filters.minTransferBytes != null && (event.encodedDataLength == null || event.encodedDataLength < filters.minTransferBytes)) {
		return false
	}

	if (filters.party && filters.partyHost) {
		const eventParty = classifyParty(event.url, filters.partyHost)
		if (eventParty == null || eventParty !== filters.party) {
			return false
		}
	}

	return true
}

export const derivePartyHost = (url: string | null): string | null => {
	if (!url) {
		return null
	}

	const hostname = parseUrl(url)?.hostname?.toLowerCase()
	if (!hostname) {
		return null
	}

	if (hostname === 'localhost' || isIpAddress(hostname)) {
		return hostname
	}

	const segments = hostname.split('.').filter(Boolean)
	if (segments.length < 2) {
		return hostname
	}

	return segments.slice(-2).join('.')
}

export const normalizeNetUrlKey = (url: string | null | undefined): string | null => {
	if (!url || url.trim() === '') {
		return null
	}

	try {
		const parsed = new URL(url)
		return `${parsed.origin}${parsed.pathname || '/'}`
	} catch {
		return url.split(/[?#]/, 1)[0] || null
	}
}

const matchesStatusFilter = (status: number | null, filters: string[]): boolean => {
	if (status == null) {
		return false
	}

	const value = String(status)
	return filters.some((candidate) => {
		const normalized = candidate.trim().toLowerCase()
		if (!normalized) {
			return false
		}
		if (normalized.endsWith('xx') && normalized.length === 3) {
			return value.startsWith(normalized[0] ?? '')
		}
		return normalized === value
	})
}

const isFailedRequest = (event: NetworkRequestSummary): boolean => event.errorText != null || (event.status != null && event.status >= 400)

const matchesFrameFilter = (event: NetworkRequestSummary, filters: NetFilters): boolean => {
	if (!filters.frameId && !filters.documentUrlKey) {
		return true
	}

	const matchesFrameId = filters.frameId != null && event.frameId === filters.frameId
	const matchesDocumentUrl = filters.documentUrlKey != null && normalizeNetUrlKey(event.documentUrl) === filters.documentUrlKey
	return matchesFrameId || matchesDocumentUrl
}

const classifyParty = (url: string, partyHost: string): NetParty | null => {
	const hostname = parseUrl(url)?.hostname?.toLowerCase()
	if (!hostname) {
		return null
	}

	return hostname === partyHost || hostname.endsWith(`.${partyHost}`) ? 'first' : 'third'
}

const matchesHostList = (url: string, candidates: string[]): boolean => {
	const parsed = parseUrl(url)
	const hostname = parsed?.hostname?.toLowerCase()
	const host = parsed?.host?.toLowerCase()

	return candidates.some((candidate) => {
		const normalized = candidate.trim().toLowerCase()
		if (!normalized) {
			return false
		}
		if (hostname && (hostname === normalized || hostname.endsWith(`.${normalized}`))) {
			return true
		}
		return host === normalized
	})
}

const parseUrl = (value: string): URL | null => {
	try {
		return new URL(value)
	} catch {
		return null
	}
}

const isIpAddress = (value: string): boolean => /^(\d{1,3}\.){3}\d{1,3}$/.test(value) || value.includes(':')
