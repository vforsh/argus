import type { LogEvent, WatcherRecord } from '@vforsh/argus-core'
import { formatLogLevelTag } from '@vforsh/argus-core'

type WatcherLineStatus = { attached: boolean; target?: { title: string | null; url: string | null } | null }

/**
 * Format a watcher line for human output.
 *
 * @param status The probed `/status`, `'unreachable'` when the probe failed, or omitted when the
 *   caller never probed (candidate lists). Omitted prints no state: these lines used to say
 *   `[unknown]` for every candidate, which read as a broken watcher rather than "not checked".
 */
export const formatWatcherLine = (watcher: WatcherRecord, status?: WatcherLineStatus | 'unreachable'): string => {
	const base = `${watcher.id} ${watcher.host}:${watcher.port}`
	const match = formatMatch(watcher)
	const cwd = formatCwd(watcher)
	const state = formatWatcherState(watcher, status)
	const target = typeof status === 'object' ? status.target : null
	const targetLabel = target?.title || target?.url ? `${target?.title ?? ''}${target?.title && target?.url ? ' • ' : ''}${target?.url ?? ''}` : ''
	const targetSuffix = targetLabel ? ` (${targetLabel})` : ''

	return [base, match, cwd, state ? `[${state}]` : ''].filter(Boolean).join(' ') + targetSuffix
}

/** A control watcher brokers tabs and never attaches to one, so "detached" would misreport it. */
const formatWatcherState = (watcher: WatcherRecord, status: WatcherLineStatus | 'unreachable' | undefined): string | null => {
	if (status === 'unreachable') {
		return 'unreachable'
	}
	if (watcher.extensionRole === 'control') {
		return 'control'
	}
	if (!status) {
		return null
	}
	return status.attached ? 'attached' : 'detached'
}

/** Format a log event for human output. */
export const formatLogEvent = (event: LogEvent, options?: { includeTimestamps?: boolean }): string => {
	const timestamp = options?.includeTimestamps ? `${new Date(event.ts).toISOString()} ` : ''
	const tag = formatLogLevelTag(event.level)
	const header = `${timestamp}${tag} | ${event.text}`.trim()
	const location = event.file ? `${event.file}${formatLineColumn(event)}` : null
	if (!location) {
		return header
	}

	return `${header} at ${location}`
}

const formatMatch = (watcher: WatcherRecord): string => {
	if (!watcher.match) {
		return ''
	}

	if (watcher.match.url) {
		return `url:${watcher.match.url}`
	}

	if (watcher.match.title) {
		return `title:${watcher.match.title}`
	}

	if (watcher.match.urlRegex) {
		return `url~${watcher.match.urlRegex}`
	}

	if (watcher.match.titleRegex) {
		return `title~${watcher.match.titleRegex}`
	}

	return ''
}

const formatCwd = (watcher: WatcherRecord): string => {
	if (!watcher.cwd) {
		return ''
	}
	return `cwd:${watcher.cwd}`
}

const formatLineColumn = (event: LogEvent): string => {
	if (event.line == null) {
		return ''
	}

	if (event.column == null) {
		return `:${event.line}`
	}

	return `:${event.line}:${event.column}`
}
