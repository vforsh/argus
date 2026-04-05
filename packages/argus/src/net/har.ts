import type { NetworkRequestDetail } from '@vforsh/argus-core'

type HarLog = {
	version: '1.2'
	creator: { name: string; version: string }
	pages: HarPage[]
	entries: HarEntry[]
}

type HarPage = {
	startedDateTime: string
	id: string
	title: string
	pageTimings: {
		onContentLoad: number
		onLoad: number
	}
}

type HarEntry = {
	pageref?: string
	startedDateTime: string
	time: number
	request: HarRequest
	response: HarResponse
	cache: Record<string, never>
	timings: HarTimings
	serverIPAddress?: string
	connection?: string
}

type HarRequest = {
	method: string
	url: string
	httpVersion: string
	cookies: HarCookie[]
	headers: HarHeader[]
	queryString: HarParam[]
	headersSize: number
	bodySize: number
}

type HarResponse = {
	status: number
	statusText: string
	httpVersion: string
	cookies: HarCookie[]
	headers: HarHeader[]
	content: {
		size: number
		mimeType: string
	}
	redirectURL: string
	headersSize: number
	bodySize: number
}

type HarTimings = {
	blocked: number
	dns: number
	connect: number
	send: number
	wait: number
	receive: number
	ssl: number
}

type HarHeader = {
	name: string
	value: string
}

type HarParam = {
	name: string
	value: string
}

type HarCookie = {
	name: string
	value: string
}

export type HarDocument = {
	log: HarLog
}

/**
 * Convert redacted Argus request details into a HAR 1.2 document.
 * We derive the start timestamp from `ts - durationMs` because the watcher stores
 * completion time plus duration, not the raw start wall-clock.
 */
export const buildHarFromNetworkRequests = (requests: NetworkRequestDetail[]): HarDocument => {
	const sorted = [...requests].sort((left, right) => deriveStartedAt(left) - deriveStartedAt(right))
	const { pages, pageIdByDocumentUrl } = buildHarPages(sorted)

	return {
		log: {
			version: '1.2',
			creator: {
				name: 'Argus',
				version: 'unknown',
			},
			pages,
			entries: sorted.map((request) => toHarEntry(request, pageIdByDocumentUrl)),
		},
	}
}

const buildHarPages = (requests: NetworkRequestDetail[]): { pages: HarPage[]; pageIdByDocumentUrl: Map<string, string> } => {
	const pages: HarPage[] = []
	const pageIdByDocumentUrl = new Map<string, string>()

	for (const request of requests) {
		if (!request.documentUrl || pageIdByDocumentUrl.has(request.documentUrl)) {
			continue
		}

		const pageId = `page_${pages.length + 1}`
		pageIdByDocumentUrl.set(request.documentUrl, pageId)
		pages.push({
			id: pageId,
			title: request.documentUrl,
			startedDateTime: toIsoString(deriveStartedAt(request)),
			pageTimings: {
				onContentLoad: -1,
				onLoad: -1,
			},
		})
	}

	return { pages, pageIdByDocumentUrl }
}

const toHarEntry = (request: NetworkRequestDetail, pageIdByDocumentUrl: Map<string, string>): HarEntry => {
	const startedAt = deriveStartedAt(request)
	const durationMs = getRequestDurationMs(request)
	const pageref = request.documentUrl ? pageIdByDocumentUrl.get(request.documentUrl) : undefined
	const httpVersion = toHarHttpVersion(request.protocol)

	return {
		pageref,
		startedDateTime: toIsoString(startedAt),
		time: durationMs,
		request: {
			method: request.method,
			url: request.url,
			httpVersion,
			cookies: [],
			headers: toHarHeaders(request.requestHeaders),
			queryString: toHarQueryParams(request.url),
			headersSize: -1,
			bodySize: -1,
		},
		response: {
			status: request.status ?? 0,
			statusText: request.statusText ?? request.errorText ?? '',
			httpVersion,
			cookies: [],
			headers: toHarHeaders(request.responseHeaders),
			content: {
				size: toHarContentSize(request),
				mimeType: request.mimeType ?? 'application/octet-stream',
			},
			redirectURL: '',
			headersSize: -1,
			// CDP exposes encoded transfer size but not exact response-body bytes here.
			bodySize: toHarBodySize(request),
		},
		cache: {},
		timings: {
			blocked: toHarTiming(request.timingPhases?.blockedMs),
			dns: toHarTiming(request.timingPhases?.dnsMs),
			connect: toHarTiming(request.timingPhases?.connectMs),
			send: toHarTiming(request.timingPhases?.sendMs),
			wait: toHarTiming(request.timingPhases?.waitMs),
			receive: toHarTiming(request.timingPhases?.downloadMs),
			ssl: toHarTiming(request.timingPhases?.sslMs),
		},
		serverIPAddress: request.remoteAddress ?? undefined,
		connection: request.remotePort != null ? String(request.remotePort) : undefined,
	}
}

const getRequestDurationMs = (request: NetworkRequestDetail): number => request.timingPhases?.totalMs ?? request.durationMs ?? 0

const deriveStartedAt = (request: NetworkRequestDetail): number => request.ts - Math.max(0, request.durationMs ?? request.timingPhases?.totalMs ?? 0)

const toIsoString = (timestampMs: number): string => new Date(timestampMs).toISOString()

const toHarHttpVersion = (protocol: string | null): string => {
	if (!protocol) {
		return 'unknown'
	}

	const normalized = protocol.trim().toLowerCase()
	if (normalized === 'h2' || normalized === 'http/2' || normalized === 'http/2.0') {
		return 'HTTP/2'
	}
	if (normalized === 'http/1.1' || normalized === 'http/1.0') {
		return normalized.toUpperCase()
	}
	return protocol
}

const toHarHeaders = (headers?: Record<string, string>): HarHeader[] =>
	Object.entries(headers ?? {}).map(([name, value]) => ({
		name,
		value,
	}))

const toHarQueryParams = (value: string): HarParam[] => {
	try {
		const url = new URL(value)
		return Array.from(url.searchParams.entries()).map(([name, paramValue]) => ({
			name,
			value: paramValue,
		}))
	} catch {
		return []
	}
}

const toHarContentSize = (request: NetworkRequestDetail): number => request.encodedDataLength ?? 0

const toHarBodySize = (request: NetworkRequestDetail): number => request.encodedDataLength ?? -1

const toHarTiming = (value: number | null | undefined): number => (value == null ? -1 : value)
