import type { LogEvent } from './logs.js'
import type { WatcherRecord } from '../registry/types.js'

/** Response payload for GET /status. */
export type StatusResponse = {
	ok: true
	id: string
	pid: number
	attached: boolean
	target: {
		title: string | null
		url: string | null
	} | null
	buffer: {
		size: number
		count: number
		minId: number | null
		maxId: number | null
	}
	watcher: WatcherRecord
}

/** Response payload for GET /logs. */
export type LogsResponse = {
	ok: true
	events: LogEvent[]
	nextAfter: number
}

/** Response payload for GET /tail. */
export type TailResponse = {
	ok: true
	events: LogEvent[]
	nextAfter: number
	timedOut: boolean
}

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

/** Request payload for POST /eval. */
export type EvalRequest = {
	expression: string
	awaitPromise?: boolean
	timeoutMs?: number
	returnByValue?: boolean
}

/** Response payload for POST /eval. */
export type EvalResponse = {
	ok: true
	result: unknown
	type: string | null
	exception: { text: string; details?: unknown } | null
}

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

/** Request payload for POST /screenshot. */
export type ScreenshotRequest = {
	outFile?: string
	selector?: string
	format?: 'png'
}

/** Response payload for POST /screenshot. */
export type ScreenshotResponse = {
	ok: true
	outFile: string
	clipped: boolean
}

/** Standard error payload for API failures. */
export type ErrorResponse = {
	ok: false
	error: {
		message: string
		code?: string
	}
}
