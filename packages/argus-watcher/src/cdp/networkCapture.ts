import type {
	NetworkInitiator,
	NetworkInitiatorStackFrame,
	NetworkRedirectHop,
	NetworkRequestDetail,
	NetworkRequestSummary,
	NetworkTimingPhases,
} from '@vforsh/argus-core'
import type { NetBuffer } from '../buffer/NetBuffer.js'
import type { CdpSessionHandle } from './connection.js'
import { captureHeaders, mergeCapturedAuthHeaders, mergeCapturedHeaders, pickCapturedAuthHeaders, redactUrl } from './redaction.js'

type ResponseTimingPayload = {
	dnsStart?: number
	dnsEnd?: number
	connectStart?: number
	connectEnd?: number
	sslStart?: number
	sslEnd?: number
	sendStart?: number
	sendEnd?: number
	receiveHeadersEnd?: number
}

type RedirectResponsePayload = {
	url?: string
	status?: number
	statusText?: string
	headers?: Record<string, unknown>
}

type InflightRequest = {
	requestId: string
	url: string
	method: string
	summaryRequestHeaders?: Record<string, string>
	requestHeaders?: Record<string, string>
	responseHeaders?: Record<string, string>
	resourceType: string | null
	status: number | null
	statusText: string | null
	mimeType: string | null
	encodedDataLength: number | null
	errorText: string | null
	startTime: number | null
	endTime: number | null
	documentUrl: string | null
	frameId: string | null
	loaderId: string | null
	initiator: NetworkInitiator | null
	redirects: NetworkRedirectHop[]
	servedFromCache: boolean
	fromDiskCache: boolean
	fromPrefetchCache: boolean
	fromServiceWorker: boolean
	serviceWorkerResponseSource: string | null
	remoteAddress: string | null
	remotePort: number | null
	protocol: string | null
	priority: string | null
	responseTiming: ResponseTimingPayload | null
}

export type NetworkCaptureHandle = {
	onAttached: () => Promise<void>
	onDetached: () => void
}

/**
 * Subscribe to CDP network events and keep a compact summary plus a richer request record.
 * `/net` stays cheap, while `/net/request` can expose the high-signal debugging fields.
 */
export const createNetworkCapture = (options: { session: CdpSessionHandle; buffer: NetBuffer }): NetworkCaptureHandle => {
	const inflight = new Map<string, InflightRequest>()

	const getOrCreate = (requestId: string): InflightRequest => {
		const existing = inflight.get(requestId)
		if (existing) {
			return existing
		}
		const next = createInflightRequest(requestId)
		inflight.set(requestId, next)
		return next
	}

	const finalize = (requestId: string): void => {
		const record = inflight.get(requestId)
		if (!record) {
			return
		}
		inflight.delete(requestId)

		const durationMs =
			record.startTime != null && record.endTime != null ? Math.max(0, Math.round((record.endTime - record.startTime) * 1000)) : null
		const timingPhases = buildTimingPhases(record.responseTiming, durationMs)

		const summary: Omit<NetworkRequestSummary, 'id'> = {
			ts: Date.now(),
			requestId: record.requestId,
			url: sanitizeUrl(record.url),
			method: record.method,
			documentUrl: sanitizeOptionalUrl(record.documentUrl),
			requestHeaders: record.summaryRequestHeaders,
			resourceType: record.resourceType,
			mimeType: record.mimeType,
			frameId: record.frameId,
			status: record.status,
			encodedDataLength: record.encodedDataLength,
			errorText: record.errorText,
			durationMs,
		}

		const detail: Omit<NetworkRequestDetail, 'id'> = {
			...summary,
			requestHeaders: record.requestHeaders,
			responseHeaders: record.responseHeaders,
			statusText: record.statusText,
			loaderId: record.loaderId,
			initiator: record.initiator,
			redirects: record.redirects,
			servedFromCache: record.servedFromCache,
			fromDiskCache: record.fromDiskCache,
			fromPrefetchCache: record.fromPrefetchCache,
			fromServiceWorker: record.fromServiceWorker,
			serviceWorkerResponseSource: record.serviceWorkerResponseSource,
			remoteAddress: record.remoteAddress,
			remotePort: record.remotePort,
			protocol: record.protocol,
			priority: record.priority,
			timingPhases,
		}

		options.buffer.add({ summary, detail })
	}

	options.session.onEvent('Network.requestWillBeSent', (params) => {
		const payload = params as {
			requestId?: string
			request?: {
				url?: string
				method?: string
				headers?: Record<string, unknown>
				initialPriority?: string
			}
			timestamp?: number
			type?: string
			documentURL?: string
			frameId?: string
			loaderId?: string
			initiator?: unknown
			redirectResponse?: RedirectResponsePayload
		}
		const requestId = payload.requestId
		if (!requestId) {
			return
		}

		const entry = getOrCreate(requestId)
		const nextUrl = payload.request?.url ?? entry.url

		if (payload.redirectResponse && entry.url) {
			entry.redirects.push({
				fromUrl: sanitizeUrl(entry.url),
				toUrl: sanitizeUrl(nextUrl),
				status: pickNumber(payload.redirectResponse.status),
				statusText: normalizeString(payload.redirectResponse.statusText),
			})
			resetRedirectState(entry)
		}

		entry.url = nextUrl
		entry.method = payload.request?.method ?? entry.method
		mergeRequestHeaders(entry, payload.request?.headers)
		entry.resourceType = payload.type ?? entry.resourceType
		entry.startTime = pickNumber(payload.timestamp) ?? entry.startTime
		entry.documentUrl = payload.documentURL ?? entry.documentUrl
		entry.frameId = payload.frameId ?? entry.frameId
		entry.loaderId = payload.loaderId ?? entry.loaderId
		entry.initiator = normalizeInitiator(payload.initiator) ?? entry.initiator
		entry.priority = normalizeString(payload.request?.initialPriority) ?? entry.priority
	})

	options.session.onEvent('Network.requestWillBeSentExtraInfo', (params) => {
		const payload = params as {
			requestId?: string
			headers?: Record<string, unknown>
		}
		const requestId = payload.requestId
		if (!requestId) {
			return
		}
		const entry = getOrCreate(requestId)
		mergeRequestHeaders(entry, payload.headers)
	})

	options.session.onEvent('Network.responseReceived', (params) => {
		const payload = params as {
			requestId?: string
			response?: {
				url?: string
				status?: number
				statusText?: string
				mimeType?: string
				protocol?: string
				remoteIPAddress?: string
				remotePort?: number
				headers?: Record<string, unknown>
				requestHeaders?: Record<string, unknown>
				fromDiskCache?: boolean
				fromPrefetchCache?: boolean
				fromServiceWorker?: boolean
				serviceWorkerResponseSource?: string
				timing?: ResponseTimingPayload
			}
			type?: string
		}
		const requestId = payload.requestId
		if (!requestId) {
			return
		}

		const entry = getOrCreate(requestId)
		entry.url = payload.response?.url ?? entry.url
		entry.status = pickNumber(payload.response?.status) ?? entry.status
		entry.statusText = normalizeString(payload.response?.statusText) ?? entry.statusText
		entry.mimeType = normalizeString(payload.response?.mimeType) ?? entry.mimeType
		entry.protocol = normalizeString(payload.response?.protocol) ?? entry.protocol
		entry.remoteAddress = normalizeString(payload.response?.remoteIPAddress) ?? entry.remoteAddress
		entry.remotePort = pickNumber(payload.response?.remotePort) ?? entry.remotePort
		mergeRequestHeaders(entry, payload.response?.requestHeaders)
		mergeResponseHeaders(entry, payload.response?.headers)
		entry.resourceType = payload.type ?? entry.resourceType
		entry.fromDiskCache = Boolean(payload.response?.fromDiskCache) || entry.fromDiskCache
		entry.fromPrefetchCache = Boolean(payload.response?.fromPrefetchCache) || entry.fromPrefetchCache
		entry.fromServiceWorker = Boolean(payload.response?.fromServiceWorker) || entry.fromServiceWorker
		entry.serviceWorkerResponseSource = normalizeString(payload.response?.serviceWorkerResponseSource) ?? entry.serviceWorkerResponseSource
		entry.responseTiming = payload.response?.timing ?? entry.responseTiming
	})

	options.session.onEvent('Network.responseReceivedExtraInfo', (params) => {
		const payload = params as {
			requestId?: string
			statusCode?: number
			headers?: Record<string, unknown>
		}
		const requestId = payload.requestId
		if (!requestId) {
			return
		}
		const entry = getOrCreate(requestId)
		entry.status = pickNumber(payload.statusCode) ?? entry.status
		mergeResponseHeaders(entry, payload.headers)
	})

	options.session.onEvent('Network.requestServedFromCache', (params) => {
		const payload = params as { requestId?: string }
		if (!payload.requestId) {
			return
		}
		getOrCreate(payload.requestId).servedFromCache = true
	})

	options.session.onEvent('Network.resourceChangedPriority', (params) => {
		const payload = params as { requestId?: string; newPriority?: string }
		if (!payload.requestId) {
			return
		}
		const entry = getOrCreate(payload.requestId)
		entry.priority = normalizeString(payload.newPriority) ?? entry.priority
	})

	options.session.onEvent('Network.loadingFinished', (params) => {
		const payload = params as { requestId?: string; encodedDataLength?: number; timestamp?: number }
		const requestId = payload.requestId
		if (!requestId) {
			return
		}
		const entry = getOrCreate(requestId)
		entry.encodedDataLength = pickNumber(payload.encodedDataLength) ?? entry.encodedDataLength
		entry.endTime = pickNumber(payload.timestamp) ?? entry.endTime
		finalize(requestId)
	})

	options.session.onEvent('Network.loadingFailed', (params) => {
		const payload = params as { requestId?: string; errorText?: string; timestamp?: number }
		const requestId = payload.requestId
		if (!requestId) {
			return
		}
		const entry = getOrCreate(requestId)
		entry.errorText = payload.errorText ?? entry.errorText
		entry.endTime = pickNumber(payload.timestamp) ?? entry.endTime
		finalize(requestId)
	})

	return {
		onAttached: async () => {
			await options.session.sendAndWait('Network.enable')
		},
		onDetached: () => {
			inflight.clear()
		},
	}
}

const createInflightRequest = (requestId: string): InflightRequest => ({
	requestId,
	url: '',
	method: 'GET',
	summaryRequestHeaders: undefined,
	requestHeaders: undefined,
	responseHeaders: undefined,
	resourceType: null,
	status: null,
	statusText: null,
	mimeType: null,
	encodedDataLength: null,
	errorText: null,
	startTime: null,
	endTime: null,
	documentUrl: null,
	frameId: null,
	loaderId: null,
	initiator: null,
	redirects: [],
	servedFromCache: false,
	fromDiskCache: false,
	fromPrefetchCache: false,
	fromServiceWorker: false,
	serviceWorkerResponseSource: null,
	remoteAddress: null,
	remotePort: null,
	protocol: null,
	priority: null,
	responseTiming: null,
})

const mergeRequestHeaders = (entry: InflightRequest, headers: Record<string, unknown> | undefined): void => {
	entry.summaryRequestHeaders = mergeCapturedAuthHeaders(entry.summaryRequestHeaders, pickCapturedAuthHeaders(headers))
	entry.requestHeaders = mergeCapturedHeaders(entry.requestHeaders, captureHeaders(headers))
}

const mergeResponseHeaders = (entry: InflightRequest, headers: Record<string, unknown> | undefined): void => {
	entry.responseHeaders = mergeCapturedHeaders(entry.responseHeaders, captureHeaders(headers))
}

const resetRedirectState = (entry: InflightRequest): void => {
	entry.status = null
	entry.statusText = null
	entry.mimeType = null
	entry.encodedDataLength = null
	entry.errorText = null
	entry.endTime = null
	entry.responseHeaders = undefined
	entry.servedFromCache = false
	entry.fromDiskCache = false
	entry.fromPrefetchCache = false
	entry.fromServiceWorker = false
	entry.serviceWorkerResponseSource = null
	entry.remoteAddress = null
	entry.remotePort = null
	entry.protocol = null
	entry.responseTiming = null
}

const buildTimingPhases = (timing: ResponseTimingPayload | null, totalMs: number | null): NetworkTimingPhases | null => {
	if (!timing && totalMs == null) {
		return null
	}

	const receiveHeadersEnd = normalizePhaseValue(timing?.receiveHeadersEnd)
	return {
		totalMs,
		blockedMs: receiveHeadersEnd != null ? derivePositiveDuration(0, timing?.dnsStart) : null,
		dnsMs: derivePositiveDuration(timing?.dnsStart, timing?.dnsEnd),
		connectMs: derivePositiveDuration(timing?.connectStart, timing?.connectEnd),
		sslMs: derivePositiveDuration(timing?.sslStart, timing?.sslEnd),
		sendMs: derivePositiveDuration(timing?.sendStart, timing?.sendEnd),
		waitMs: derivePositiveDuration(timing?.sendEnd, timing?.receiveHeadersEnd),
		downloadMs: totalMs != null && receiveHeadersEnd != null ? Math.max(0, totalMs - receiveHeadersEnd) : null,
	}
}

const derivePositiveDuration = (start: number | undefined, end: number | undefined): number | null => {
	const normalizedStart = normalizePhaseValue(start)
	const normalizedEnd = normalizePhaseValue(end)
	if (normalizedStart == null || normalizedEnd == null) {
		return null
	}
	return Math.max(0, Math.round(normalizedEnd - normalizedStart))
}

const normalizePhaseValue = (value: number | undefined): number | null => {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		return null
	}
	return value
}

const normalizeInitiator = (value: unknown): NetworkInitiator | null => {
	if (!value || typeof value !== 'object') {
		return null
	}

	const payload = value as {
		type?: unknown
		url?: unknown
		lineNumber?: unknown
		columnNumber?: unknown
		requestId?: unknown
		stack?: { callFrames?: unknown[]; parent?: unknown } | null
	}

	const stack = flattenInitiatorStack(payload.stack)
	const url = typeof payload.url === 'string' ? sanitizeUrl(payload.url) : null
	const lineNumber = pickNumber(payload.lineNumber)
	const columnNumber = pickNumber(payload.columnNumber)
	const requestId = typeof payload.requestId === 'string' ? payload.requestId : null

	if (!stack.length && url == null && lineNumber == null && columnNumber == null && requestId == null && typeof payload.type !== 'string') {
		return null
	}

	return {
		type: typeof payload.type === 'string' ? payload.type : null,
		url,
		lineNumber,
		columnNumber,
		requestId,
		stack,
	}
}

const flattenInitiatorStack = (stack: { callFrames?: unknown[]; parent?: unknown } | null | undefined): NetworkInitiatorStackFrame[] => {
	const frames: NetworkInitiatorStackFrame[] = []
	let current = stack
	let depth = 0

	while (current && depth < 4) {
		const payload = current as { callFrames?: unknown[]; parent?: unknown }
		for (const frame of payload.callFrames ?? []) {
			if (!frame || typeof frame !== 'object') {
				continue
			}
			const callFrame = frame as {
				functionName?: unknown
				url?: unknown
				lineNumber?: unknown
				columnNumber?: unknown
			}
			if (typeof callFrame.url !== 'string' || callFrame.url.trim() === '') {
				continue
			}
			frames.push({
				functionName: normalizeString(callFrame.functionName),
				url: sanitizeUrl(callFrame.url),
				lineNumber: pickNumber(callFrame.lineNumber),
				columnNumber: pickNumber(callFrame.columnNumber),
			})
		}

		current = payload.parent as { callFrames?: unknown[]; parent?: unknown } | null | undefined
		depth += 1
	}

	return frames
}

const sanitizeUrl = (value: string): string => redactUrl(value)

const sanitizeOptionalUrl = (value: string | null): string | null => (value ? sanitizeUrl(value) : null)

const pickNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

const normalizeString = (value: unknown): string | null => {
	if (typeof value !== 'string') {
		return null
	}
	const trimmed = value.trim()
	return trimmed || null
}
