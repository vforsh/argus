import type { LogEvent } from '../logs.js'

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
