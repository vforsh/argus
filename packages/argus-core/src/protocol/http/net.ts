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

/** Whether Argus expects request/response bodies to be fetchable for a buffered entry. */
export type NetworkBodyAvailability = {
	request: boolean
	response: boolean
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
	body: NetworkBodyAvailability
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

/** Which body payload to fetch for a buffered request. */
export type NetRequestBodyPart = 'request' | 'response'

/** Response payload for GET /net/request/body. */
export type NetRequestBodyResponse = {
	ok: true
	id: number
	requestId: string
	part: NetRequestBodyPart
	mimeType: string | null
	body: string
	base64Encoded: boolean
}

/** Direction for a captured WebSocket frame preview. */
export type NetWebSocketFrameDirection = 'sent' | 'received'

/** Bounded preview of a WebSocket frame payload. */
export type NetWebSocketFramePreview = {
	ts: number
	direction: NetWebSocketFrameDirection
	opcode: number | null
	mask: boolean | null
	payloadLength: number
	preview: string | null
	base64Encoded: boolean
	error: string | null
}

/** Compact WebSocket connection record for `net ws`. */
export type NetWebSocketSummary = {
	id: number
	ts: number
	requestId: string
	url: string
	documentUrl: string | null
	frameId: string | null
	state: 'created' | 'open' | 'closed' | 'error'
	status: number | null
	statusText: string | null
	createdAt: number
	openedAt: number | null
	closedAt: number | null
	durationMs: number | null
	sentFrames: number
	receivedFrames: number
	sentBytes: number
	receivedBytes: number
	closeCode: number | null
	closeReason: string | null
	errorText: string | null
}

/** Detailed WebSocket connection record for `net ws show`. */
export type NetWebSocketDetail = NetWebSocketSummary & {
	requestHeaders?: Record<string, string>
	responseHeaders?: Record<string, string>
	recentFrames: NetWebSocketFramePreview[]
}

/** Request-level SSE/EventSource visibility record. */
export type NetSseSummary = {
	id: number
	ts: number
	requestId: string
	url: string
	method: string
	documentUrl: string | null
	frameId: string | null
	status: number | null
	statusText: string | null
	mimeType: string | null
	state: 'open' | 'closed' | 'error'
	openedAt: number
	closedAt: number | null
	durationMs: number | null
	encodedDataLength: number | null
	eventCount: number
	lastEventId: string | null
	lastEventName: string | null
	lastDataPreview: string | null
	errorText: string | null
}

/** Response payload for GET /net/ws. */
export type NetWebSocketsResponse = {
	ok: true
	connections: NetWebSocketSummary[]
	nextAfter: number
}

/** Response payload for GET /net/ws/connection. */
export type NetWebSocketResponse = {
	ok: true
	connection: NetWebSocketDetail
}

/** Response payload for GET /net/sse. */
export type NetSseResponse = {
	ok: true
	streams: NetSseSummary[]
	nextAfter: number
}
