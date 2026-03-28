import type { LogEvent, LogLevel } from '@vforsh/argus-core'
import { previewStringify } from '@vforsh/argus-core'
import type { IgnoreMatcher } from './ignoreList.js'
import { stripUrlPrefixes } from './locationCleanup.js'
import type { CallFrame, SelectedLocation } from './selectBestFrame.js'
import { selectBestFrame } from './selectBestFrame.js'
import { resolveSourcemappedLocation } from '../sourcemaps/resolveLocation.js'
import type { CdpSessionHandle } from './connection.js'
import { serializeRemoteObject, serializeRemoteObjects } from './remoteObject.js'
import type { CdpTarget } from './watcherTargets.js'

export type PageIntlInfo = {
	timezone: string | null
	locale: string | null
}

type WatcherEventConfig = {
	ignoreMatcher?: IgnoreMatcher | null
	stripUrlPrefixes?: string[]
	cdp?: CdpSessionHandle
}

export const toConsoleEvent = async (params: unknown, target: CdpTarget, config: WatcherEventConfig): Promise<Omit<LogEvent, 'id'>> => {
	const record = params as {
		type?: LogLevel
		args?: unknown[]
		stackTrace?: { callFrames?: CallFrame[] }
	}
	const cdp = config.cdp
	const runtimeClient = cdp ? { sendAndWait: (method: string, params?: Record<string, unknown>) => cdp.sendAndWait(method, params) } : undefined
	const args = Array.isArray(record.args) ? await serializeRemoteObjects(record.args, runtimeClient) : []
	const text = formatArgs(args)
	const baseEvent: Omit<LogEvent, 'id'> = {
		ts: Date.now(),
		level: normalizeLevel(record.type ?? 'log'),
		text,
		args,
		file: null,
		line: null,
		column: null,
		pageUrl: target.url ?? null,
		pageTitle: target.title ?? null,
		source: 'console',
	}

	const selected = await selectLocationFromFrames(record.stackTrace?.callFrames, config.ignoreMatcher ?? null)
	if (selected) {
		return applyLocationCleanup({ ...baseEvent, ...selected }, config.stripUrlPrefixes)
	}

	const fallback = await applySourcemap(applyFirstFrame(baseEvent, record.stackTrace?.callFrames))
	return applyLocationCleanup(fallback, config.stripUrlPrefixes)
}

export const toExceptionEvent = async (params: unknown, target: CdpTarget, config: WatcherEventConfig): Promise<Omit<LogEvent, 'id'>> => {
	const record = params as {
		exceptionDetails?: {
			text?: string
			exception?: unknown
			stackTrace?: { callFrames?: CallFrame[] }
		}
	}
	const details = record.exceptionDetails
	const cdp = config.cdp
	const runtimeClient = cdp ? { sendAndWait: (method: string, params?: Record<string, unknown>) => cdp.sendAndWait(method, params) } : undefined
	const exceptionValue = details?.exception ? await serializeRemoteObject(details.exception, runtimeClient) : null
	const args = exceptionValue != null ? [exceptionValue] : []
	const exceptionDescription = describeExceptionValue(exceptionValue)
	const text = formatExceptionText(details?.text, exceptionDescription)
	const baseEvent: Omit<LogEvent, 'id'> = {
		ts: Date.now(),
		level: 'exception',
		text,
		args,
		file: null,
		line: null,
		column: null,
		pageUrl: target.url ?? null,
		pageTitle: target.title ?? null,
		source: 'exception',
	}

	const selected = await selectLocationFromFrames(details?.stackTrace?.callFrames, config.ignoreMatcher ?? null)
	if (selected) {
		return applyLocationCleanup({ ...baseEvent, ...selected }, config.stripUrlPrefixes)
	}

	const fallback = await applySourcemap(applyFirstFrame(baseEvent, details?.stackTrace?.callFrames))
	return applyLocationCleanup(fallback, config.stripUrlPrefixes)
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
