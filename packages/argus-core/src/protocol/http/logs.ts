import type { LogEvent } from '../logs.js'

/** Response payload for GET /logs. */
export type LogsResponse = {
	ok: true
	events: LogEvent[]
	nextAfter: number
}

/** Response payload for GET /logs/cursor. */
export type LogCursorResponse = {
	ok: true
	/** Highest log event id allocated by the watcher, or zero before the first event. */
	cursor: number
}

/** Response payload for GET /tail. */
export type TailResponse = {
	ok: true
	events: LogEvent[]
	nextAfter: number
	timedOut: boolean
}
