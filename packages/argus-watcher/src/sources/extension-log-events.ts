import type { LogEvent, LogLevel } from '@vforsh/argus-core'
import { previewStringify } from '@vforsh/argus-core'

type SessionSummary = {
	url: string
	title: string
}

export const toConsoleEvent = (
	params: unknown,
	session: SessionSummary,
	config: { ignoreMatcher?: ((url: string) => boolean) | null; stripUrlPrefixes?: string[] },
): Omit<LogEvent, 'id'> => {
	const record = params as {
		type?: LogLevel | string
		args?: Array<{ type: string; value?: unknown; description?: string }>
		timestamp?: number
		stackTrace?: { callFrames?: Array<{ url: string; lineNumber: number; columnNumber: number }> }
	}

	const args = record.args?.map((arg) => arg.value) ?? []
	const text = formatArgs(record.args ?? [])
	const frame = selectBestFrame(record.stackTrace?.callFrames, config.ignoreMatcher)

	return {
		ts: record.timestamp ?? Date.now(),
		level: normalizeLevel(record.type ?? 'log'),
		text,
		args,
		source: 'console',
		file: applyStripPrefixes(frame?.url ?? null, config.stripUrlPrefixes),
		line: frame?.lineNumber != null ? frame.lineNumber + 1 : null,
		column: frame?.columnNumber != null ? frame.columnNumber + 1 : null,
		pageUrl: session.url,
		pageTitle: session.title,
	}
}

export const toExceptionEvent = (
	params: unknown,
	session: SessionSummary,
	config: { ignoreMatcher?: ((url: string) => boolean) | null; stripUrlPrefixes?: string[] },
): Omit<LogEvent, 'id'> => {
	const record = params as {
		timestamp?: number
		exceptionDetails?: {
			text?: string
			exception?: { description?: string; value?: unknown }
			stackTrace?: { callFrames?: Array<{ url: string; lineNumber: number; columnNumber: number }> }
		}
	}

	const details = record.exceptionDetails
	const text = details?.exception?.description ?? details?.text ?? 'Exception'
	const args = details?.exception ? [details.exception.value ?? details.exception.description] : []
	const frame = selectBestFrame(details?.stackTrace?.callFrames, config.ignoreMatcher)

	return {
		ts: record.timestamp ?? Date.now(),
		level: 'exception',
		text,
		args,
		source: 'exception',
		file: applyStripPrefixes(frame?.url ?? null, config.stripUrlPrefixes),
		line: frame?.lineNumber != null ? frame.lineNumber + 1 : null,
		column: frame?.columnNumber != null ? frame.columnNumber + 1 : null,
		pageUrl: session.url,
		pageTitle: session.title,
	}
}

const formatArgs = (args: Array<{ type: string; value?: unknown; description?: string }>): string => {
	if (args.length === 0) {
		return ''
	}

	return args
		.map((arg) => {
			if (arg.value !== undefined) {
				return typeof arg.value === 'string' ? arg.value : previewStringify(arg.value)
			}
			return arg.description ?? `[${arg.type}]`
		})
		.join(' ')
}

const normalizeLevel = (type: LogLevel | string): LogEvent['level'] => {
	switch (type) {
		case 'log':
		case 'info':
		case 'debug':
		case 'dir':
		case 'dirxml':
		case 'table':
		case 'trace':
		case 'count':
		case 'timeEnd':
		case 'timeLog':
			return type === 'debug' ? 'debug' : type === 'info' ? 'info' : 'log'
		case 'warn':
		case 'warning':
			return 'warning'
		case 'error':
		case 'assert':
		case 'exception':
			return type === 'exception' ? 'exception' : 'error'
		default:
			return 'log'
	}
}

type CallFrame = { url: string; lineNumber: number; columnNumber: number }

const selectBestFrame = (frames: CallFrame[] | undefined, ignoreMatcher: ((url: string) => boolean) | null | undefined): CallFrame | null => {
	if (!frames || frames.length === 0) {
		return null
	}

	if (!ignoreMatcher) {
		return frames[0] ?? null
	}

	for (const frame of frames) {
		if (frame.url && !ignoreMatcher(frame.url)) {
			return frame
		}
	}

	return frames[0] ?? null
}

const applyStripPrefixes = (file: string | null, prefixes: string[] | undefined): string | null => {
	if (!file || !prefixes || prefixes.length === 0) {
		return file
	}

	for (const prefix of prefixes) {
		if (file.startsWith(prefix)) {
			return file.slice(prefix.length)
		}
	}

	return file
}
