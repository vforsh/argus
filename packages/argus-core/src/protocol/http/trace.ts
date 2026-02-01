/** Request payload for POST /trace/start. */
export type TraceStartRequest = {
	outFile?: string
	categories?: string
	options?: string
}

/** Response payload for POST /trace/start. */
export type TraceStartResponse = {
	ok: true
	traceId: string
	outFile: string
}

/** Request payload for POST /trace/stop. */
export type TraceStopRequest = {
	traceId?: string
}

/** Response payload for POST /trace/stop. */
export type TraceStopResponse = {
	ok: true
	outFile: string
}
