import type { WatcherMatch, WatcherChrome, WatcherRecord, LogEvent } from '@vforsh/argus-core'
import Emittery from 'emittery'
import { resolveUniqueWatcherId } from './registry/registry.js'
import { createWatcherHandle } from './startWatcherRuntime.js'
import type { ArgusWatcherEventMap } from './events.js'
import type { HttpRequestEvent } from './events.js'
import type { PageIndicatorOptions } from './cdp/pageIndicator.js'

/** Context for the optional log filename builder callback. */
export type BuildFilenameContext = {
	/** Unique watcher identifier. */
	watcherId: string
	/** Watcher start time as milliseconds since Unix epoch. */
	startedAt: number
	/** Watcher start time formatted for use in a filename (ISO but with ":" replaced by "-"). */
	startedAtSafe: string
	/** Sequence number of the log file within the current watcher session (starts at 1). */
	fileIndex: number
}

/** Configuration for artifacts storage (logs, traces, screenshots). */
export type ArtifactsOptions = {
	/**
	 * Base directory for all artifacts.
	 * Defaults to `$TMPDIR/argus/<watcherId>`.
	 */
	base?: string
	/** Optional file log persistence settings. Disabled by default. */
	logs?: {
		/** Enable file logging. Defaults to `false`. */
		enabled?: boolean
		/** Whether to include ISO timestamps in log records. Defaults to `false`. */
		includeTimestamps?: boolean
		/** Max number of log files to keep for this watcher. Defaults to `5`. */
		maxFiles?: number
		/** Optional callback to customize the log filename. Return null/undefined to use default. */
		buildFilename?: (context: BuildFilenameContext) => string | undefined | null
	}
	/** Trace recording settings. Enabled by default. */
	traces?: {
		/** Enable trace recording. Defaults to `true`. */
		enabled?: boolean
	}
	/** Screenshot capture settings. Enabled by default. */
	screenshots?: {
		/** Enable screenshot capture. Defaults to `true`. */
		enabled?: boolean
	}
}

/** Configuration for network request capture. */
export type NetOptions = {
	/** Enable network request capture. Defaults to `false`. */
	enabled?: boolean
}

/** Page console logging level for watcher lifecycle and request logs. */
export type PageConsoleLogging = 'none' | 'minimal' | 'full'

/** Source mode for CDP connection. */
export type WatcherSourceMode = 'cdp' | 'extension'

/** Options to start a watcher server. */
export type StartWatcherOptions = {
	/** Unique watcher identifier (used for registry presence and removal on shutdown). */
	id: string
	/**
	 * Source mode for CDP connection.
	 * - `cdp` (default): Connect directly to Chrome via WebSocket.
	 * - `extension`: Connect via Chrome extension Native Messaging.
	 */
	source?: WatcherSourceMode
	/** Host/interface to bind the watcher HTTP server to. Defaults to `127.0.0.1`. */
	host?: string
	/** Port to bind the watcher HTTP server to. Defaults to `0` (ephemeral). */
	port?: number
	/** Criteria for which Chrome target(s) to attach to. Only used in CDP mode. */
	match?: WatcherMatch
	/** Chrome DevTools Protocol (CDP) connection settings. Defaults to `127.0.0.1:9222`. Only used in CDP mode. */
	chrome?: WatcherChrome
	/** Max buffered log events before older entries are dropped. Defaults to `50_000`. */
	bufferSize?: number
	/** How often (in ms) to refresh the watcher record in the registry. Defaults to `15_000`. */
	heartbeatMs?: number
	/**
	 * Artifacts storage configuration for logs, traces, and screenshots.
	 * All artifacts are stored under `artifacts.base` (default: `$TMPDIR/argus`).
	 * Subdirectories: `logs/`, `traces/`, `screenshots/`.
	 */
	artifacts?: ArtifactsOptions
	/** Optional ignore list filtering when selecting log/exception locations. */
	ignoreList?: {
		/** Enable ignore list filtering for log/exception locations. */
		enabled?: boolean
		/** Regex patterns (as strings) to ignore when selecting a stack frame. */
		rules?: string[]
	}
	location?: {
		/**
		 * Strip these literal prefixes from event.file for display/logging.
		 * This is cosmetic and does not affect sourcemap resolution.
		 */
		stripUrlPrefixes?: string[]
	}
	/**
	 * Optional in-page indicator showing that the watcher is attached.
	 * When enabled, a small badge is injected into the page. Clicking it shows watcher info.
	 * The indicator auto-removes via TTL if the watcher dies without cleanup.
	 * Supported in both direct CDP and Chrome extension modes.
	 */
	pageIndicator?: PageIndicatorOptions
	/**
	 * Network request capture configuration.
	 * When enabled, captures HTTP requests and exposes them via `/net` and `/net/tail` endpoints.
	 * Disabled by default. Only supported in CDP mode.
	 */
	net?: NetOptions
	/**
	 * Write watcher lifecycle and request logs into the attached page's DevTools console.
	 * - `none`: Do not write anything.
	 * - `minimal` (default): Write attach/detach lifecycle messages.
	 * - `full`: Same as minimal, plus log every HTTP request to the watcher API.
	 */
	pageConsoleLogging?: PageConsoleLogging
	/**
	 * Optional JavaScript to inject on attach and document start.
	 * The script is provided as raw text to keep watcher package filesystem-agnostic.
	 */
	inject?: {
		script: string
		exposeArgus?: boolean
	}
}

/** Handle returned by startWatcher. */
export type WatcherHandle = {
	/**
	 * The current watcher record (including id/bind address/port and CDP match settings).
	 *
	 * This is the shape announced in the local registry and the same metadata served via the HTTP API.
	 */
	watcher: WatcherRecord

	/**
	 * Event emitter for watcher lifecycle and request events.
	 * Subscribe to 'cdpAttached', 'cdpDetached', and 'httpRequested'.
	 */
	events: Emittery<ArgusWatcherEventMap>

	/**
	 * Stop the watcher and release resources.
	 *
	 * Shuts down CDP attachment, stops the HTTP server, closes any artifact writers (file logs),
	 * clears event listeners, and removes the watcher from the local registry.
	 *
	 * Safe to call multiple times.
	 */
	close: () => Promise<void>
}

/**
 * Start a watcher that connects to Chrome (via CDP or extension), buffers console logs, and exposes the HTTP API.
 * @param options - Configuration for binding, source mode, and buffering.
 * @returns A handle that can be closed to stop the watcher and clean up registry state.
 */
export const startWatcher = async (options: StartWatcherOptions): Promise<WatcherHandle> => {
	if (!options.id) {
		throw new Error('Watcher id is required')
	}

	const watcherId = await resolveUniqueWatcherId(options.id)
	return createWatcherHandle(options, watcherId)
}

/** Log event shape emitted by watchers. */
export type { LogEvent }

export type { ArgusWatcherEventMap, CdpAttachedEvent, CdpDetachedEvent, HttpRequestEvent, LogRequestQuery, NetRequestQuery } from './events.js'

export type { PageIndicatorOptions, PageIndicatorPosition } from './cdp/pageIndicator.js'
