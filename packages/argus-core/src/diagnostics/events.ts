/** Bounded, content-free lifecycle evidence shared by the worker and native host. */
export type LifecycleEvent = {
	ts: number
	session: string
	operation: string
	detail: Record<string, string | number | boolean | null>
}

const ERROR_CATEGORIES = [
	'host module missing',
	'host executable missing',
	'SyntaxError',
	'No SW',
	'timed out',
	'disconnected',
	'not found',
	'Access denied',
	'Specified native messaging host not found',
	'Native host has exited',
	'Error when communicating with the native messaging host',
	'Access to the specified native messaging host is forbidden',
	'Failed to start native messaging host',
	'Receiving end does not exist',
]

/**
 * Keep known Chrome failure wording and bundled source locations; discard arbitrary error/user text.
 * @param error An Error or Chrome callback error message; arbitrary strings are never returned.
 * @returns A fixed category and sanitized stack locations (empty when unavailable).
 */
export function errorEvidence(error: unknown): Record<string, string> {
	const message = error instanceof Error ? error.message : String(error)
	const category = [...ERROR_CATEGORIES].reverse().find((value) => message.toLowerCase().includes(value.toLowerCase())) ?? 'unclassified'
	const stack =
		error instanceof Error
			? ((error.stack ?? '')
					.match(
						/(?:service-worker|bridge-client|action-badge|control-bridge-session|tab-bridge-session|lifecycle-journal)\.(?:js|ts):\d+:\d+/g,
					)
					?.slice(0, 6)
					.join('\n') ?? '')
			: ''
	return { category, stack }
}

/**
 * Extract protocol metadata only; never persist payloads, URLs, titles, cookies or eval results.
 * @param message A parsed native protocol message, including messages from older peers.
 * @returns Correlation, type and transport outcome fields; no request/response payload.
 */
export function messageEvidence(message: unknown): Record<string, string | number> {
	if (!message || typeof message !== 'object') return {}
	const value = message as Record<string, unknown>
	const result: Record<string, string | number> = {}
	if (typeof value.type === 'string' && /^[a-z_]{1,64}$/.test(value.type)) result.type = value.type
	for (const key of ['requestId', 'pid', 'protocolVersion']) {
		if (typeof value[key] === 'number') result[key] = value[key]
	}
	if (typeof value.correlationId === 'string' && /^[a-f0-9-]{36}$/.test(value.correlationId)) result.correlationId = value.correlationId
	if (typeof result.type === 'string' && result.type.endsWith('_response')) result.outcome = value.error || value.ok === false ? 'error' : 'success'
	return result
}

/**
 * Keep requests and handshakes, excluding high-volume unsolicited CDP/page traffic and journal mirrors.
 * @param metadata Output of messageEvidence.
 * @returns Whether this message belongs in the bounded lifecycle journal.
 */
export function shouldJournalMessage(metadata: ReturnType<typeof messageEvidence>): boolean {
	return (typeof metadata.requestId === 'number' && metadata.requestId !== 0) || metadata.type === 'host_info' || metadata.type === 'host_ready'
}

/**
 * Validate persisted/wire journal data and bound its size before accepting it into an incident.
 * @param value Untrusted JSON from storage or a mirrored journal.
 * @returns A fresh event containing recognized metadata only, or null for invalid identity/time fields.
 */
export function normalizeLifecycleEvent(value: unknown): LifecycleEvent | null {
	if (!value || typeof value !== 'object') return null
	const event = value as LifecycleEvent
	if (
		!Number.isFinite(event.ts) ||
		event.ts < 0 ||
		event.ts > 8640000000000000 ||
		!/^(?:[a-f0-9-]{36}|wrapper-\d+)$/.test(event.session) ||
		!/^[a-zA-Z.]{1,80}$/.test(event.operation)
	)
		return null
	const detail: LifecycleEvent['detail'] = {}
	if (event.detail && typeof event.detail === 'object') {
		for (const [key, item] of Object.entries(event.detail).slice(0, 24)) {
			if (
				typeof item === 'number' &&
				Number.isFinite(item) &&
				/^(pid|parentPid|requestId|protocolVersion|attempt|delayMs|elapsedMs|deadline|timeoutMs|code|timestampResolutionMs|sequence|eventLoopDelayMs)$/.test(
					key,
				)
			)
				detail[key] = item
			if (typeof item !== 'string') continue
			if (key === 'category' && (ERROR_CATEGORIES.includes(item) || item === 'unclassified')) detail[key] = item
			if (key === 'stack')
				detail[key] =
					item
						.match(/[\w-]+\.(?:js|ts):\d+:\d+/g)
						?.slice(0, 6)
						.join('\n') ?? ''
			if (key === 'host' && /^com\.vforsh\.argus\.(bridge|control)$/.test(item)) detail[key] = item
			if ((key === 'correlationId' || key === 'channel') && /^[a-f0-9-]{36}$/.test(item)) detail[key] = item
			if (/^(extensionVersion|nativeHostVersion|cliVersion|runtime)$/.test(key) && /^v?\d+[.\w-]{0,48}$/.test(item)) detail[key] = item
			if (key === 'outcome' && ['error', 'success'].includes(item)) detail[key] = item
			if (key === 'type' && /^[a-z_]{1,64}$/.test(item)) detail[key] = item
			if (key === 'reason' && ['install', 'update', 'chrome_update', 'shared_module_update'].includes(item)) detail[key] = item
		}
	}
	return { ts: event.ts, session: event.session, operation: event.operation, detail }
}
