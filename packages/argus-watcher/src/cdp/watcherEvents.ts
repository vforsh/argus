import type { LogEvent, LogLevel, LogSource } from '@vforsh/argus-core'
import { previewStringify } from '@vforsh/argus-core'
import type { IgnoreMatcher } from './ignoreList.js'
import { stripUrlPrefixes } from './locationCleanup.js'
import type { CallFrame } from './selectBestFrame.js'
import { selectBestFrame } from './selectBestFrame.js'
import type { SourcemapResolver } from '../sourcemaps/sourcemapResolver.js'
import type { CdpSessionHandle } from './connection.js'
import { serializeRemoteObject, serializeRemoteObjects, serializeRemoteObjectSync } from './remoteObject.js'

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
	signal?: AbortSignal
	ignoreMatcher?: IgnoreMatcher | null
	stripUrlPrefixes?: string[]
	cdp?: CdpSessionHandle
	/** Required so every source wires the watcher-scoped cache; there is no module-global fallback. */
	sourcemaps: SourcemapResolver
}

/** Work admitted by the watcher ingestion queue; cancellation must stop further enrichment. */
export type LogEnrichment = (signal: AbortSignal) => Promise<Omit<LogEvent, 'id'>>

/** An immutable arrival-time view and optional asynchronous enrichment for the same event. */
export type CapturedLog = { event: Omit<LogEvent, 'id'>; enrich: LogEnrichment }

/** Capture console values/previews and generated location synchronously, before any map or CDP I/O. */
export const captureConsoleEvent = (params: unknown, page: LogEventPageInfo, config: WatcherEventConfig): CapturedLog => {
	const record = params as { type?: LogLevel; args?: unknown[]; timestamp?: number; stackTrace?: { callFrames?: CallFrame[] } }
	const values = Array.isArray(record.args) ? record.args : []
	const args = values.map(serializeRemoteObjectSync)
	const base = createBaseEvent(record.timestamp, normalizeLevel(record.type ?? 'log'), formatArgs(args), args, 'console', page)
	const frames = record.stackTrace?.callFrames
	return {
		event: applyGeneratedLocation(base, frames, config),
		enrich: async (signal) => {
			signal.throwIfAborted()
			const args = await serializeRemoteObjects(values, config.cdp, signal)
			signal.throwIfAborted()
			return applyLocation({ ...base, args, text: formatArgs(args) }, frames, { ...config, signal })
		},
	}
}

/** Capture exceptions with the same ingestion/enrichment contract as console events. */
export const captureExceptionEvent = (params: unknown, page: LogEventPageInfo, config: WatcherEventConfig): CapturedLog => {
	const record = params as {
		timestamp?: number
		exceptionDetails?: { text?: string; exception?: unknown; stackTrace?: { callFrames?: CallFrame[] } }
	}
	const details = record.exceptionDetails
	const value = details?.exception ? serializeRemoteObjectSync(details.exception) : null
	const args = value != null ? [value] : []
	const base = createBaseEvent(record.timestamp, 'exception', formatExceptionText(details?.text, describeExceptionValue(value)), args, 'exception', page)
	const frames = details?.stackTrace?.callFrames
	return {
		event: applyGeneratedLocation(base, frames, config),
		enrich: async (signal) => {
			signal.throwIfAborted()
			const value = details?.exception ? await serializeRemoteObject(details.exception, config.cdp, signal) : null
			signal.throwIfAborted()
			return applyLocation({
				...base,
				args: value != null ? [value] : [],
				text: formatExceptionText(details?.text, describeExceptionValue(value)),
			}, frames, { ...config, signal })
		},
	}
}

/** Fully enrich a console payload. Source handlers use captureConsoleEvent for synchronous ingestion. */
export const toConsoleEvent = async (params: unknown, page: LogEventPageInfo, config: WatcherEventConfig): Promise<Omit<LogEvent, 'id'>> =>
	captureConsoleEvent(params, page, config).enrich(config.signal ?? new AbortController().signal)

/** Fully enrich an exception payload; generated locations survive failed/absent sourcemaps. */
export const toExceptionEvent = async (params: unknown, page: LogEventPageInfo, config: WatcherEventConfig): Promise<Omit<LogEvent, 'id'>> =>
	captureExceptionEvent(params, page, config).enrich(config.signal ?? new AbortController().signal)

const createBaseEvent = (
	timestamp: number | undefined, level: LogLevel, text: string, args: unknown[], source: LogSource, page: LogEventPageInfo,
): Omit<LogEvent, 'id'> => ({
	ts: resolveTimestamp(timestamp), level, text, args, source,
	file: null, line: null, column: null, pageUrl: page.url ?? null, pageTitle: page.title ?? null,
})

const applyGeneratedLocation = (event: Omit<LogEvent, 'id'>, frames: CallFrame[] | undefined, config: WatcherEventConfig): Omit<LogEvent, 'id'> => {
	const frame = frames?.find((frame) => frame.url && frame.lineNumber != null && frame.columnNumber != null && !config.ignoreMatcher?.matches(frame.url))
	return applyLocationCleanup(applyFirstFrame(event, frame ? [frame] : frames), config.stripUrlPrefixes)
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
	const selected = config.ignoreMatcher
		? await selectBestFrame(callFrames, config.ignoreMatcher, config.sourcemaps, config.signal)
		: null
	if (selected) {
		return applyLocationCleanup({ ...event, ...selected }, config.stripUrlPrefixes)
	}

	const fallback = await applySourcemap(applyFirstFrame(event, callFrames), config.sourcemaps, config.signal)
	return applyLocationCleanup(fallback, config.stripUrlPrefixes)
}

/** CDP reports `Runtime.Timestamp` as milliseconds since epoch; fall back to arrival time. */
const resolveTimestamp = (timestamp: number | undefined): number =>
	typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : Date.now()

const applySourcemap = async (event: Omit<LogEvent, 'id'>, sourcemaps: SourcemapResolver, signal?: AbortSignal): Promise<Omit<LogEvent, 'id'>> => {
	if (!event.file || event.line == null || event.column == null) {
		return event
	}
	try {
		const resolved = await sourcemaps.resolve({
			file: event.file,
			line: event.line,
			column: event.column,
		}, signal)
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
