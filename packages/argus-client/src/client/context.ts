import type { ArgusClientOptions } from '../types.js'
import { DEFAULT_TTL_MS } from '@vforsh/argus-core'

/**
 * Resolved client configuration shared by every method group.
 * Built once by `createArgusClient` and threaded into the group factories.
 */
export type ClientContext = {
	/** Override registry path instead of using `ARGUS_REGISTRY_PATH` / default. */
	registryPath?: string
	/** TTL used for pruning stale watchers before registry reads. */
	ttlMs: number
	/** Timeout for cheap registry/status probes. */
	listTimeoutMs: number
	/** Default timeout for watcher data requests (logs, net, eval, screenshot). */
	requestTimeoutMs: number
}

/** Registry-scoped subset of {@link ClientContext} accepted by `requestWatcher`. */
export type RegistryContext = Pick<ClientContext, 'registryPath' | 'ttlMs'>

/**
 * Timeout for screenshots. Well above the default request budget: a full-page capture on a
 * busy renderer can outlast it, and a transport timeout evicts the watcher from the registry.
 */
export const SCREENSHOT_TIMEOUT_MS = 15_000

/** Timeout for trace start, which may block while Chrome spins up the tracing backend. */
export const TRACE_START_TIMEOUT_MS = 10_000

/** Timeout for trace stop, which drains and writes the full event stream. */
export const TRACE_STOP_TIMEOUT_MS = 20_000

/** Timeout for record start/stop; encoding a captured buffer can outlast a normal request. */
export const RECORD_TIMEOUT_MS = 30_000

/** Normalize user-supplied client options into a fully resolved {@link ClientContext}. */
export const createClientContext = (options: ArgusClientOptions): ClientContext => ({
	registryPath: options.registryPath,
	ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
	listTimeoutMs: options.timeoutMs ?? 2_000,
	requestTimeoutMs: options.timeoutMs ?? 5_000,
})
