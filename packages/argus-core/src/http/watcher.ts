import type { WatcherRecord } from '../registry/types.js'
import { isHttpResponseError, isHttpTimeoutError } from './fetch.js'

/** Extract an error message from an unknown thrown value. */
export const formatError = (error: unknown): string => {
	if (!error) {
		return 'unknown error'
	}
	if (error instanceof Error) {
		return error.message
	}
	return String(error)
}

/** Build the URL for a watcher endpoint. */
export const buildWatcherUrl = (watcher: Pick<WatcherRecord, 'host' | 'port'>, path: string, query?: URLSearchParams): string => {
	const qs = query?.toString()
	return `http://${watcher.host}:${watcher.port}${path}${qs ? `?${qs}` : ''}`
}

/** Describe a failure to reach a watcher, in the phrasing both the CLI and the SDK surface. */
export const formatWatcherTransportError = (watcher: Pick<WatcherRecord, 'id'>, error: unknown): string =>
	`${watcher.id}: failed to reach watcher (${formatError(error)})`

/**
 * How a failed watcher request should be interpreted.
 *
 * - `api-rejection`: the watcher answered and refused this request, so it is demonstrably alive.
 * - `unreachable`: nothing is listening on the watcher's port (connection refused, DNS failure,
 *   host unreachable). Strong evidence the watcher is gone.
 * - `transport`: the request failed without saying anything about liveness — a timeout or abort,
 *   which a slow command produces against a perfectly healthy watcher.
 */
export type WatcherFailureKind = 'api-rejection' | 'unreachable' | 'transport'

/**
 * Classify a thrown watcher-request failure.
 *
 * Identified by what we can recognize reliably rather than by errno: `fetch` reports connection
 * failures with runtime-specific shapes (Bun sets `code: 'ConnectionRefused'` on the error, Node
 * nests an errno under `cause`), so anything that is neither our own response error nor our own
 * timeout is treated as the connection never having been answered.
 */
export const classifyWatcherFailure = (error: unknown): WatcherFailureKind => {
	if (isHttpResponseError(error)) {
		return 'api-rejection'
	}

	return isHttpTimeoutError(error) ? 'transport' : 'unreachable'
}

/**
 * Whether a failed request should evict the watcher from the shared on-disk registry.
 *
 * The registry is shared between the CLI and the SDK, so this decision cannot live on one side:
 * an eviction by either stack deletes an entry the other reads. Only `unreachable` evicts. An
 * `api-rejection` came from a live watcher, and a `transport` failure is a timeout on a slow
 * command — evicting there would delete healthy watchers mid-session.
 */
export const shouldEvictWatcherOnFailure = (failure: WatcherFailureKind): boolean => failure === 'unreachable'
