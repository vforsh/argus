export type LogLevel = 'log' | 'info' | 'warning' | 'error' | 'debug' | 'exception'

export type LogSource = 'console' | 'exception' | 'system'

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

export const LOG_LEVELS: LogLevel[] = ['log', 'info', 'warning', 'error', 'debug', 'exception']
