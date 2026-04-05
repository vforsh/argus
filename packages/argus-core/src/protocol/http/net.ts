/** Network request summary captured from CDP. */
export type NetworkRequestSummary = {
	id: number
	ts: number
	requestId: string
	url: string
	method: string
	documentUrl: string | null
	/** Captured auth-related request headers with sensitive values redacted. */
	requestHeaders?: Record<string, string>
	resourceType: string | null
	mimeType: string | null
	frameId: string | null
	status: number | null
	encodedDataLength: number | null
	errorText: string | null
	durationMs: number | null
	// later: add redacted request/response headers behind a flag.
}

/** Single stack frame from a network initiator trace. */
export type NetworkInitiatorStackFrame = {
	functionName: string | null
	url: string
	lineNumber: number | null
	columnNumber: number | null
}

/** Why a request started, when CDP can attribute it. */
export type NetworkInitiator = {
	type: string | null
	url: string | null
	lineNumber: number | null
	columnNumber: number | null
	requestId: string | null
	stack: NetworkInitiatorStackFrame[]
}

/** Redirect hop observed before the final request URL. */
export type NetworkRedirectHop = {
	fromUrl: string
	toUrl: string
	status: number | null
	statusText: string | null
}

/** High-signal request timing breakdown derived from CDP response timing. */
export type NetworkTimingPhases = {
	totalMs: number | null
	blockedMs: number | null
	dnsMs: number | null
	connectMs: number | null
	sslMs: number | null
	sendMs: number | null
	waitMs: number | null
	downloadMs: number | null
}

/** Full request record used by `net show`. */
export type NetworkRequestDetail = NetworkRequestSummary & {
	requestHeaders?: Record<string, string>
	responseHeaders?: Record<string, string>
	statusText: string | null
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
	timingPhases: NetworkTimingPhases | null
}

/** Response payload for GET /net. */
export type NetResponse = {
	ok: true
	requests: NetworkRequestSummary[]
	nextAfter: number
}

/** Response payload for GET /net/requests. */
export type NetRequestsResponse = {
	ok: true
	requests: NetworkRequestDetail[]
	nextAfter: number
}

/** Response payload for GET /net/tail. */
export type NetTailResponse = {
	ok: true
	requests: NetworkRequestSummary[]
	nextAfter: number
	timedOut: boolean
}

/** Response payload for POST /net/clear. */
export type NetClearResponse = {
	ok: true
	/** Number of buffered requests removed. */
	cleared: number
}

/** Response payload for GET /net/request. */
export type NetRequestResponse = {
	ok: true
	request: NetworkRequestDetail
}
