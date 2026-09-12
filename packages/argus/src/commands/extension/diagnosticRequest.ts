import { randomUUID } from 'node:crypto'
import { readLifecycleEvents, toSearchParams, type ExtensionDiagnosticsQuery, type WatcherRecord } from '@vforsh/argus-core'
import { fetchWatcherJson } from '../../watchers/requestWatcher.js'
import { formatError } from '../../cli/parse.js'

/** Bounded request evidence. A sent request is never presented as proof of peer receipt. */
export type DiagnosticTrace = {
	correlationId: string
	startedAt: number
	deadline: number
	elapsedMs: number
	path: string
	lastConfirmedPhase: string
	outcome: 'response' | 'error'
	applicationOk: boolean | null
}

/** Probe one layer with a deadline; on failure return its trace rather than discard other results. */
export async function diagnosticRequest<T>(
	watcher: WatcherRecord,
	path: string,
	timeoutMs: number,
	options: { method?: 'POST'; body?: unknown } = {},
) {
	const correlationId = randomUUID()
	const startedAt = Date.now()
	const startedAtMono = performance.now()
	const query: ExtensionDiagnosticsQuery = { correlationId }
	const trace: DiagnosticTrace = {
		correlationId,
		startedAt,
		deadline: startedAt + timeoutMs,
		elapsedMs: 0,
		path,
		lastConfirmedPhase: 'HTTP request attempted; peer receipt unconfirmed',
		outcome: 'error',
		applicationOk: null,
	}
	try {
		const response = await fetchWatcherJson<T>(watcher, {
			path,
			timeoutMs,
			...options,
			returnErrorResponse: true,
			query: path === '/extension/diagnostics' ? toSearchParams(query) : undefined,
		})
		trace.outcome = 'response'
		const applicationOk = response && typeof response === 'object' ? (response as { ok?: unknown }).ok : null
		trace.applicationOk = typeof applicationOk === 'boolean' ? applicationOk : null
		trace.lastConfirmedPhase = 'HTTP JSON response received (inspect response.ok for application success)'
		return { ok: true as const, response, trace }
	} catch (error) {
		const events = readLifecycleEvents().events.filter((event) => event.detail.correlationId === correlationId)
		const last = events.at(-1)
		if (last) trace.lastConfirmedPhase = `${last.operation} observed at ${last.ts}; no HTTP JSON response received`
		return { ok: false as const, error: `${formatError(error)}; ${trace.lastConfirmedPhase}; correlation ${correlationId}`, trace }
	} finally {
		trace.elapsedMs = Math.round(performance.now() - startedAtMono)
	}
}
