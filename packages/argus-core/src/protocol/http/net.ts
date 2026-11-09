import type { Ok } from './errors.js'
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
	/** Live socket state for `resourceType: 'WebSocket'` rows; frames are read with `GET /net/ws/frames`. */
	webSocket?: NetWebSocketNetInfo
	// later: add redacted request/response headers behind a flag.
}

/**
 * WebSocket counters attached to the socket's `/net` row.
 *
 * Chrome reports sockets through `Network.webSocket*` events, never `requestWillBeSent`/`loadingFinished`,
 * so the capture inserts the row itself and keeps these fields current as frames arrive.
 */
export type NetWebSocketNetInfo = {
	/** Argus WebSocket connection id (`net ws show <connectionId>`, `net ws frames --socket <connectionId>`). */
	connectionId: number
	state: NetWebSocketSummary['state']
	sentFrames: number
	receivedFrames: number
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
export type NetResponse = Ok<{
	requests: NetworkRequestSummary[]
	nextAfter: number
}>

/**
 * Response payload for GET /net/activity: what `--settle` needs to call the network quiet.
 * `pending` excludes streams and requests open longer than 10s (long polls, stalled beacons).
 */
export type NetActivityResponse = Ok<{
	pending: number
	/** Wall-clock ms of the last request start or finish; `null` before any traffic. */
	lastActivityAt: number | null
	/** The watcher's clock, so callers measure quiet time without trusting their own. */
	now: number
}>

/** Response payload for GET /net/requests. */
export type NetRequestsResponse = Ok<{
	requests: NetworkRequestDetail[]
	nextAfter: number
}>

/** Response payload for GET /net/tail. */
export type NetTailResponse = Ok<{
	requests: NetworkRequestSummary[]
	nextAfter: number
	timedOut: boolean
}>

/** Response payload for POST /net/clear. */
export type NetClearResponse = Ok<{
	/** Number of buffered requests removed. */
	cleared: number
}>

/** Response payload for POST /net/cache/clear. */
export type NetCacheClearResponse = Ok<{}>

/** Response payload for GET /net/request. */
export type NetRequestResponse = Ok<{
	request: NetworkRequestDetail
}>

/** Which body payload to fetch for a buffered request. */
export type NetRequestBodyPart = 'request' | 'response'

/** Response payload for GET /net/request/body. */
export type NetRequestBodyResponse = Ok<{
	id: number
	requestId: string
	part: NetRequestBodyPart
	mimeType: string | null
	body: string
	base64Encoded: boolean
}>

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

/**
 * One captured WebSocket frame, in capture order across all sockets.
 *
 * Text frames (opcode 1) carry their payload as-is; binary frames (opcode 2) carry base64. The watcher stores a
 * bounded prefix of each payload (64 KiB of characters), so `truncated` can be set even without a caller-side cap;
 * `payloadLength` is always the real byte length on the wire.
 */
export type NetWebSocketFrame = {
	/** Monotonic frame id; the cursor for `after`. */
	id: number
	/** Argus WebSocket connection id. */
	connectionId: number
	requestId: string
	/** Redacted socket URL. */
	url: string
	/** Wall-clock ms when the watcher received the frame event. */
	ts: number
	direction: NetWebSocketFrameDirection
	/** RFC 6455 opcode: 1 text, 2 binary (CDP reports data frames only). */
	opcode: number | null
	mask: boolean | null
	/** Payload size in bytes (decoded for binary frames). */
	payloadLength: number
	/** Text payload, or base64 for binary frames; cut to the stored or requested cap. */
	payload: string
	base64Encoded: boolean
	truncated: boolean
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
export type NetWebSocketsResponse = Ok<{
	connections: NetWebSocketSummary[]
	nextAfter: number
}>

/** Response payload for GET /net/ws/connection. */
export type NetWebSocketResponse = Ok<{
	connection: NetWebSocketDetail
}>

/** Response payload for GET /net/ws/frames. */
export type NetWebSocketFramesResponse = Ok<{
	frames: NetWebSocketFrame[]
	nextAfter: number
	/** Set when the request long-polled (`timeoutMs`) and no frame matched before the deadline. */
	timedOut: boolean
	/** Newest frame id captured so far, ignoring filters (0 before the first); pass as `after` to follow from now. */
	latestId: number
}>

/** Response payload for GET /net/sse. */
export type NetSseResponse = Ok<{
	streams: NetSseSummary[]
	nextAfter: number
}>
