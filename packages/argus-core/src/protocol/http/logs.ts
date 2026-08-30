import type { LogEpoch, LogEvent } from '../logs.js'
import type { Ok } from './errors.js'

/** Response payload for GET /logs. */
export type LogsResponse = Ok<{
	events: LogEvent[]
	/** Opaque position after the last returned event, or the requested epoch when empty. */
	nextCursor: LogEpoch
}>

/** Response payload for GET /logs/cursor. */
export type LogCursorResponse = Ok<{
	/** Opaque position in the current watcher session. */
	cursor: LogEpoch
}>

/** Response payload for GET /logs/epoch. */
export type LogEpochResponse = Ok<{
	epoch: LogEpoch
}>

/** Response payload for GET /tail. */
export type TailResponse = Ok<{
	events: LogEvent[]
	/** Opaque position after the last returned event, or the requested epoch when empty. */
	nextCursor: LogEpoch
	timedOut: boolean
}>
