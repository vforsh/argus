import { existsSync } from 'node:fs'
import type { LogEvent, WatcherRecord } from '@vforsh/argus-core'
import { formatLogLevelTag } from '@vforsh/argus-core'
import { formatLabels } from '../watchers/labels.js'

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
	const labels = formatLabels(watcher.labels)
	const state = formatWatcherState(watcher, status)
	const target = typeof status === 'object' ? status.target : null
	const targetLabel = target?.title || target?.url ? `${target?.title ?? ''}${target?.title && target?.url ? ' • ' : ''}${target?.url ?? ''}` : ''
	const targetSuffix = targetLabel ? ` (${targetLabel})` : ''

	return [base, match, cwd, labels ? `labels=${labels}` : '', state ? `[${state}]` : ''].filter(Boolean).join(' ') + targetSuffix
}

/**
 * `id · state · title · age` — the default `argus list` row.
 *
 * Title falls back to the URL's host+path; both are cut at 40 chars. Control watchers have no page.
 */
export const formatCompactWatcherLine = (watcher: WatcherRecord, status: WatcherLineStatus, now: number): string => {
	const state = formatWatcherState(watcher, status) ?? 'unknown'
	const target = status.target
	const label = target?.title?.trim() || shortenUrl(target?.url ?? '') || ''
	return [watcher.id, state, label ? truncateLabel(label, 40) : '', formatAge(now - watcher.startedAt)].filter(Boolean).join(' · ')
}

const shortenUrl = (url: string): string => {
	try {
		const parsed = new URL(url)
		return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`
	} catch {
		return url
	}
}

const truncateLabel = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** `45s`, `12m`, `3h`, `2d`. */
export const formatAge = (ms: number): string => {
	const seconds = Math.max(0, Math.round(ms / 1000))
	if (seconds < 60) return `${seconds}s`
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`
	if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`
	return `${Math.round(seconds / 86_400)}d`
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
	// A watcher left running from a deleted worktree: say how to clean it up.
	return existsSync(watcher.cwd) ? `cwd:${watcher.cwd}` : `cwd:${watcher.cwd} (deleted; argus watcher prune)`
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
