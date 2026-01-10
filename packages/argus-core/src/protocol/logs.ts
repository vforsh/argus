/** Log severity levels emitted by watchers. */
export type LogLevel = 'log' | 'info' | 'warning' | 'error' | 'debug' | 'exception'

/** Origin for a log event. */
export type LogSource = 'console' | 'exception' | 'system'

/** Normalized log payload stored in the buffer and returned via HTTP API. */
export type LogEvent = {
	id: number
	ts: number
	level: LogLevel
	text: string
	args: unknown[]
	file: string | null
	line: number | null
	column: number | null
	pageUrl: string | null
	pageTitle: string | null
	source: LogSource
}

/** Ordered list of supported log levels. */
export const LOG_LEVELS: LogLevel[] = ['log', 'info', 'warning', 'error', 'debug', 'exception']
