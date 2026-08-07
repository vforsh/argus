import type { LogEpoch, LogEvent } from '../logs.js'

/** Response payload for GET /logs. */
export type LogsResponse = {
	ok: true
	events: LogEvent[]
	/** Opaque position after the last returned event, or the requested epoch when empty. */
	nextCursor: LogEpoch
}

/** Response payload for GET /logs/cursor. */
export type LogCursorResponse = {
	ok: true
	/** Opaque position in the current watcher session. */
	cursor: LogEpoch
}

/** Response payload for GET /logs/epoch. */
export type LogEpochResponse = {
	ok: true
	epoch: LogEpoch
}

/** Response payload for GET /tail. */
export type TailResponse = {
	ok: true
	events: LogEvent[]
	/** Opaque position after the last returned event, or the requested epoch when empty. */
	nextCursor: LogEpoch
	timedOut: boolean
}
