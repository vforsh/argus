import type { LogEvent, LogLevel } from '@vforsh/argus-core'
import { previewStringify } from '@vforsh/argus-core'
import type { IgnoreMatcher } from './ignoreList.js'
import { stripUrlPrefixes } from './locationCleanup.js'
import type { CallFrame, SelectedLocation } from './selectBestFrame.js'
import { selectBestFrame } from './selectBestFrame.js'
import { resolveSourcemappedLocation } from '../sourcemaps/resolveLocation.js'
import type { CdpSessionHandle } from './connection.js'
import { serializeRemoteObject, serializeRemoteObjects } from './remoteObject.js'

export type PageIntlInfo = {
	timezone: string | null
	locale: string | null
}

/**
 * The page identity stamped onto every log event.
 *
 * Deliberately structural rather than `CdpTarget`: extension-backed sessions carry the same
 * `url`/`title` pair, and both sources feed this one mapper (see {@link toConsoleEvent}).
 */
export type LogEventPageInfo = {
	url?: string | null
	title?: string | null
}

type WatcherEventConfig = {
	ignoreMatcher?: IgnoreMatcher | null
	stripUrlPrefixes?: string[]
	cdp?: CdpSessionHandle
}

/**
 * Map a `Runtime.consoleAPICalled` payload to a `LogEvent`.
 *
 * Source-agnostic: the direct-CDP watcher and the extension bridge both call this, so sourcemap
 * resolution, remote-object serialization, and ignore-list frame selection behave identically in
 * both modes. Pass `config.cdp` to allow serialization round-trips for objects Chrome only sent
 * an `objectId` for; without it the args degrade to their previews.
 */
export const toConsoleEvent = async (params: unknown, page: LogEventPageInfo, config: WatcherEventConfig): Promise<Omit<LogEvent, 'id'>> => {
	const record = params as {
		type?: LogLevel
		args?: unknown[]
		timestamp?: number
		stackTrace?: { callFrames?: CallFrame[] }
	}
	const cdp = config.cdp
	const args = Array.isArray(record.args) ? await serializeRemoteObjects(record.args, cdp) : []
	const text = formatArgs(args)
	const baseEvent: Omit<LogEvent, 'id'> = {
		ts: resolveTimestamp(record.timestamp),
		level: normalizeLevel(record.type ?? 'log'),
		text,
		args,
		file: null,
		line: null,
		column: null,
		pageUrl: page.url ?? null,
		pageTitle: page.title ?? null,
		source: 'console',
	}

	return applyLocation(baseEvent, record.stackTrace?.callFrames, config)
}

/**
 * Map a `Runtime.exceptionThrown` payload to a `LogEvent`. Shares every helper with
 * {@link toConsoleEvent}, including sourcemap resolution.
 */
export const toExceptionEvent = async (params: unknown, page: LogEventPageInfo, config: WatcherEventConfig): Promise<Omit<LogEvent, 'id'>> => {
	const record = params as {
		timestamp?: number
		exceptionDetails?: {
			text?: string
			exception?: unknown
			stackTrace?: { callFrames?: CallFrame[] }
		}
	}
	const details = record.exceptionDetails
	const cdp = config.cdp
	const exceptionValue = details?.exception ? await serializeRemoteObject(details.exception, cdp) : null
	const args = exceptionValue != null ? [exceptionValue] : []
	const exceptionDescription = describeExceptionValue(exceptionValue)
	const text = formatExceptionText(details?.text, exceptionDescription)
	const baseEvent: Omit<LogEvent, 'id'> = {
		ts: resolveTimestamp(record.timestamp),
		level: 'exception',
		text,
		args,
		file: null,
		line: null,
		column: null,
		pageUrl: page.url ?? null,
		pageTitle: page.title ?? null,
		source: 'exception',
	}

	return applyLocation(baseEvent, details?.stackTrace?.callFrames, config)
}

export const fetchPageIntl = async (session: CdpSessionHandle): Promise<PageIntlInfo | null> => {
	try {
		const result = await session.sendAndWait('Runtime.evaluate', {
			expression:
				'(() => { const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? null; const locale = navigator.language ?? null; return { timezone, locale }; })()',
			returnByValue: true,
		})
		const payload = result as { result?: { value?: { timezone?: unknown; locale?: unknown } } }
		const value = payload.result?.value
		if (!value || typeof value !== 'object') {
			return null
		}
		const record = value as { timezone?: unknown; locale?: unknown }
		const timezone = typeof record.timezone === 'string' && record.timezone.trim() !== '' ? record.timezone : null
		const locale = typeof record.locale === 'string' && record.locale.trim() !== '' ? record.locale : null
		return { timezone, locale }
	} catch {
		return null
	}
}

/**
 * Pick the reported frame for an event, preferring an ignore-list-filtered, sourcemapped frame and
 * falling back to the top frame. Always strips configured URL prefixes last.
 */
const applyLocation = async (
	event: Omit<LogEvent, 'id'>,
	callFrames: CallFrame[] | undefined,
	config: WatcherEventConfig,
): Promise<Omit<LogEvent, 'id'>> => {
	const selected = await selectLocationFromFrames(callFrames, config.ignoreMatcher ?? null)
	if (selected) {
		return applyLocationCleanup({ ...event, ...selected }, config.stripUrlPrefixes)
	}

	const fallback = await applySourcemap(applyFirstFrame(event, callFrames))
	return applyLocationCleanup(fallback, config.stripUrlPrefixes)
}

/** CDP reports `Runtime.Timestamp` as milliseconds since epoch; fall back to arrival time. */
const resolveTimestamp = (timestamp: number | undefined): number =>
	typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : Date.now()

const applySourcemap = async (event: Omit<LogEvent, 'id'>): Promise<Omit<LogEvent, 'id'>> => {
	if (!event.file || event.line == null || event.column == null) {
		return event
	}
	try {
		const resolved = await resolveSourcemappedLocation({
			file: event.file,
			line: event.line,
			column: event.column,
		})
		if (!resolved) {
			return event
		}
		return {
			...event,
			file: resolved.file,
			line: resolved.line,
			column: resolved.column,
		}
	} catch {
		return event
	}
}

const selectLocationFromFrames = async (
	callFrames: CallFrame[] | undefined,
	ignoreMatcher: IgnoreMatcher | null,
): Promise<SelectedLocation | null> => {
	if (!ignoreMatcher) {
		return null
	}
	return selectBestFrame(callFrames, ignoreMatcher)
}

const applyFirstFrame = (event: Omit<LogEvent, 'id'>, callFrames: CallFrame[] | undefined): Omit<LogEvent, 'id'> => {
	const frame = callFrames?.[0]
	const file = frame?.url ?? null
	const line = frame?.lineNumber != null ? frame.lineNumber + 1 : null
	const column = frame?.columnNumber != null ? frame.columnNumber + 1 : null
	return { ...event, file, line, column }
}

const applyLocationCleanup = (event: Omit<LogEvent, 'id'>, prefixes: string[] | undefined): Omit<LogEvent, 'id'> => {
	if (!event.file) {
		return event
	}
	const cleaned = stripUrlPrefixes(event.file, prefixes)
	if (cleaned === event.file) {
		return event
	}
	return { ...event, file: cleaned }
}

const describeExceptionValue = (value: unknown): string | null => {
	if (value == null) {
		return null
	}

	if (typeof value === 'string') {
		return value
	}

	try {
		return JSON.stringify(value)
	} catch {
		return String(value)
	}
}

const formatExceptionText = (baseText: string | undefined, description: string | null): string => {
	const trimmed = baseText?.trim()
	if (!trimmed) {
		return description ?? 'Exception'
	}

	if (!description) {
		return trimmed
	}

	const isGeneric = trimmed === 'Uncaught' || trimmed === 'Uncaught (in promise)'
	if (isGeneric && !trimmed.includes(description)) {
		return `${trimmed}: ${description}`
	}

	return trimmed
}

const normalizeLevel = (level: LogLevel | string): LogLevel => {
	if (level === 'warn' || level === 'warning') {
		return 'warning'
	}

	// console.assert failures arrive as type 'assert'; they are errors, not plain logs.
	if (level === 'assert') {
		return 'error'
	}

	if (level === 'error' || level === 'info' || level === 'debug' || level === 'exception' || level === 'log') {
		return level
	}

	return 'log'
}

const formatArgs = (args: unknown[]): string => {
	if (args.length === 0) {
		return ''
	}

	return args.map((arg) => previewStringify(arg)).join(' ')
}
