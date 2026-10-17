import type { ErrorResponse, StatusResponse, TraceStatusSummary, WatcherRecord } from '@vforsh/argus-core'
import { loadActiveRegistry } from '../registry.js'
import { fetchWatcherJson } from '../watchers/requestWatcher.js'
import type { Output } from '../output/io.js'
import { setExitCode } from '../output/exitCode.js'

/** A watcher that reports an active Chrome trace on GET /status. */
export type TraceHolder = {
	watcherId: string
	target: StatusResponse['target']
	trace: TraceStatusSummary
}

/**
 * Chrome's "one tracing session per browser" refusal. `trace_conflict` comes from current watchers;
 * the prose match covers older ones that forward Chrome's message uncoded.
 */
export const isTraceConflict = (error: ErrorResponse['error'] | string): boolean => {
	if (typeof error !== 'string' && error.code === 'trace_conflict') {
		return true
	}
	const message = typeof error === 'string' ? error : error.message
	return /tracing (?:has )?already (?:been )?started/i.test(message)
}

/**
 * Only watchers that can share the refusing watcher's browser can be the holder: CDP watchers on
 * the same endpoint, or any extension watcher (extension records carry no browser identity).
 */
const sharesBrowser = (candidate: WatcherRecord, reference: Pick<WatcherRecord, 'source' | 'chrome'>): boolean => {
	if ((candidate.source ?? 'cdp') !== (reference.source ?? 'cdp')) {
		return false
	}
	if (candidate.source === 'extension') {
		return candidate.extensionRole !== 'control'
	}
	return candidate.chrome?.host === reference.chrome?.host && candidate.chrome?.port === reference.chrome?.port
}

/** Ask every watcher that may share this browser whether it holds a trace. Unreachable watchers are skipped. */
export const findTraceHolders = async (reference: Pick<WatcherRecord, 'id' | 'source' | 'chrome'>): Promise<TraceHolder[]> => {
	const registry = await loadActiveRegistry().catch(() => null)
	if (!registry) {
		return []
	}

	const candidates = Object.values(registry.watchers).filter((watcher) => watcher.id !== reference.id && sharesBrowser(watcher, reference))
	const statuses = await Promise.all(
		candidates.map((watcher) =>
			fetchWatcherJson<StatusResponse>(watcher, { path: '/status', timeoutMs: 1_500 }).catch(() => null),
		),
	)

	const holders: TraceHolder[] = []
	for (const status of statuses) {
		if (status?.trace) {
			holders.push({ watcherId: status.id, target: status.target, trace: status.trace })
		}
	}
	return holders
}

/** Explain who holds Chrome's tracing session, and how to free it. */
export const describeTraceHolders = (holders: TraceHolder[]): string[] => {
	if (holders.length === 0) {
		return [
			'No argus watcher holds a trace in this browser, so another client owns it (DevTools Performance panel, another CDP client, or an extension). Stop it there and retry.',
		]
	}
	return holders.map((holder) => {
		const where = holder.target?.url ?? holder.target?.title
		const tab = holder.target?.id ? `target ${holder.target.id}` : null
		const details = [tab, where].filter(Boolean).join(', ')
		const startedAt = new Date(holder.trace.startedAt).toLocaleTimeString([], { hour12: false })
		return `Trace held by watcher "${holder.watcherId}"${details ? ` (${details})` : ''}, started ${startedAt}; stop it with: argus trace stop ${holder.watcherId}`
	})
}

/** Report a watcher's trace failure; a Chrome tracing conflict also names who holds the session. */
export const writeTraceError = async (
	watcher: Pick<WatcherRecord, 'id' | 'source' | 'chrome'>,
	response: ErrorResponse,
	output: Output,
): Promise<void> => {
	setExitCode(1)
	const holders = isTraceConflict(response.error) ? await findTraceHolders(watcher) : null
	if (output.json) {
		output.writeJson(holders ? { ...response, holders } : response)
		return
	}
	output.writeWarn(watcher.id ? `${watcher.id}: ${response.error.message}` : response.error.message)
	for (const line of holders ? describeTraceHolders(holders) : []) {
		output.writeWarn(line)
	}
}
