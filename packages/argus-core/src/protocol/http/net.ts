/** Network request summary captured from CDP. */
export type NetworkRequestSummary = {
	id: number
	ts: number
	requestId: string
	url: string
	method: string
	resourceType: string | null
	status: number | null
	encodedDataLength: number | null
	errorText: string | null
	durationMs: number | null
	// later: add redacted request/response headers behind a flag.
}

/** Response payload for GET /net. */
export type NetResponse = {
	ok: true
	requests: NetworkRequestSummary[]
	nextAfter: number
}

/** Response payload for GET /net/tail. */
export type NetTailResponse = {
	ok: true
	requests: NetworkRequestSummary[]
	nextAfter: number
	timedOut: boolean
}
