import type { LogEvent, WatcherRecord } from '@vforsh/argus-core'

/** Format a watcher line for human output. */
export const formatWatcherLine = (
	watcher: WatcherRecord,
	status?: { attached: boolean; target?: { title: string | null; url: string | null } | null },
): string => {
	const base = `${watcher.id} ${watcher.host}:${watcher.port}`
	const match = formatMatch(watcher)
	const state = status ? (status.attached ? 'attached' : 'detached') : 'unknown'
	const target = status?.target
	const targetLabel = target?.title || target?.url ? `${target?.title ?? ''}${target?.title && target?.url ? ' • ' : ''}${target?.url ?? ''}` : ''
	const targetSuffix = targetLabel ? ` (${targetLabel})` : ''

	return `${base} ${match} [${state}]${targetSuffix}`.trim()
}

/** Format a log event for human output. */
export const formatLogEvent = (event: LogEvent, watcherId?: string): string => {
	const prefix = watcherId ? `[${watcherId}] ` : ''
	const header = `${prefix}[${event.level}] ${event.text}`.trim()
	const location = event.file ? `${event.file}${formatLineColumn(event)}` : null
	if (!location) {
		return header
	}

	return `${header}\n  at ${location}`
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

const formatLineColumn = (event: LogEvent): string => {
	if (event.line == null) {
		return ''
	}

	if (event.column == null) {
		return `:${event.line}`
	}

	return `:${event.line}:${event.column}`
}
