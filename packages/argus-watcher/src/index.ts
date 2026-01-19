import type { WatcherMatch, WatcherChrome, WatcherRecord, LogEvent } from '@vforsh/argus-core'
import path from 'node:path'
import Emittery from 'emittery'
import { startCdpWatcher } from './cdp/watcher.js'
import { LogBuffer } from './buffer/LogBuffer.js'
import { NetBuffer } from './buffer/NetBuffer.js'
import { startHttpServer } from './http/server.js'
import { announceWatcher, removeWatcher, startRegistryHeartbeat } from './registry/registry.js'
import { WatcherFileLogger } from './fileLogs/WatcherFileLogger.js'
import { buildIgnoreMatcher } from './cdp/ignoreList.js'
import { createNetworkCapture } from './cdp/networkCapture.js'
import { createTraceRecorder } from './cdp/tracing.js'
import { createScreenshotter } from './cdp/screenshot.js'
import { createCdpSessionHandle } from './cdp/connection.js'
import {
	createPageIndicatorController,
	validatePageIndicatorOptions,
	type PageIndicatorOptions,
	type PageIndicatorController,
} from './cdp/pageIndicator.js'
import type { ArgusWatcherEventMap } from './events.js'
import type { HttpRequestEvent } from './events.js'

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
	 * Defaults to `<cwd>/argus-artifacts`.
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

/** Options to start a watcher server. */
export type StartWatcherOptions = {
	/** Unique watcher identifier (used for registry presence and removal on shutdown). */
	id: string
	/** Host/interface to bind the watcher HTTP server to. Defaults to `127.0.0.1`. */
	host?: string
	/** Port to bind the watcher HTTP server to. Defaults to `0` (ephemeral). */
	port?: number
	/** Criteria for which Chrome target(s) to attach to. */
	match?: WatcherMatch
	/** Chrome DevTools Protocol (CDP) connection settings. Defaults to `127.0.0.1:9222`. */
	chrome?: WatcherChrome
	/** Max buffered log events before older entries are dropped. Defaults to `50_000`. */
	bufferSize?: number
	/** How often (in ms) to refresh the watcher record in the registry. Defaults to `15_000`. */
	heartbeatMs?: number
	/**
	 * Artifacts storage configuration for logs, traces, and screenshots.
	 * All artifacts are stored under `artifacts.base` (default: `<cwd>/argus-artifacts`).
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
	 */
	pageIndicator?: PageIndicatorOptions
	/**
	 * Network request capture configuration.
	 * When enabled, captures HTTP requests and exposes them via `/net` and `/net/tail` endpoints.
	 * Disabled by default.
	 */
	net?: NetOptions
	/**
	 * Write watcher lifecycle and request logs into the attached page's DevTools console.
	 * - `none`: Do not write anything.
	 * - `minimal` (default): Write attach/detach lifecycle messages.
	 * - `full`: Same as minimal, plus log every HTTP request to the watcher API.
	 */
	pageConsoleLogging?: PageConsoleLogging
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
 * Start a watcher that connects to Chrome CDP, buffers console logs, and exposes the HTTP API.
 * @param options - Configuration for binding, CDP matching, and buffering.
 * @returns A handle that can be closed to stop the watcher and clean up registry state.
 */
export const startWatcher = async (options: StartWatcherOptions): Promise<WatcherHandle> => {
	if (!options.id) {
		throw new Error('Watcher id is required')
	}

	const host = options.host ?? '127.0.0.1'
	const port = options.port ?? 0
	const chrome = options.chrome ?? { host: '127.0.0.1', port: 9222 }
	const bufferSize = options.bufferSize ?? 50_000
	const netBufferSize = options.bufferSize ?? 50_000
	const startedAt = Date.now()
	const ignoreMatcher = buildIgnoreMatcher(options.ignoreList)
	const stripUrlPrefixes = options.location?.stripUrlPrefixes

	// Resolve artifacts configuration
	const artifactsBaseDir = resolveArtifactsBaseDir(options.artifacts?.base)
	const logsEnabled = options.artifacts?.logs?.enabled === true
	const logsDir = path.join(artifactsBaseDir, 'logs')
	const includeTimestamps = options.artifacts?.logs?.includeTimestamps ?? false
	const maxFiles = resolveMaxFiles(options.artifacts?.logs?.maxFiles)

	// Network capture is opt-in (disabled by default)
	const netEnabled = options.net?.enabled === true

	// Page console logging (default: minimal)
	const pageConsoleLogging = options.pageConsoleLogging ?? 'minimal'
	const watcherId = options.id

	const events = new Emittery<ArgusWatcherEventMap>()
	const buffer = new LogBuffer(bufferSize)
	const netBuffer = netEnabled ? new NetBuffer(netBufferSize) : null
	let closing = false
	let readyForShutdown = false
	let shutdownRequested = false
	let closeOnce: (() => Promise<void>) | null = null
	let cdpStatus: {
		attached: boolean
		target: { title: string | null; url: string | null } | null
		reason?: string | null
	} = { attached: false, target: null }

	const fileLogger = logsEnabled
		? new WatcherFileLogger({
				watcherId: options.id,
				startedAt,
				logsDir,
				chrome,
				match: options.match,
				maxFiles,
				includeTimestamps,
				buildFilename: options.artifacts?.logs?.buildFilename,
			})
		: null

	const record: WatcherRecord = {
		id: options.id,
		host,
		port,
		pid: process.pid,
		cwd: process.cwd(),
		startedAt,
		updatedAt: Date.now(),
		match: options.match,
		chrome,
		includeTimestamps,
	}

	const sessionHandle = createCdpSessionHandle()

	const logToPageConsole = (message: string): void => {
		if (pageConsoleLogging === 'none') {
			return
		}
		if (!sessionHandle.session.isAttached()) {
			return
		}
		const fullMessage = `[ARGUS] ${watcherId} :: ${message}`
		queueMicrotask(() => {
			sessionHandle.session
				.sendAndWait('Runtime.evaluate', {
					expression: `console.log(${JSON.stringify(fullMessage)})`,
					silent: true,
				})
				.catch(() => {})
		})
	}

	const networkCapture = netBuffer ? createNetworkCapture({ session: sessionHandle.session, buffer: netBuffer }) : null
	const traceRecorder = createTraceRecorder({ session: sessionHandle.session, artifactsDir: artifactsBaseDir })
	const screenshotter = createScreenshotter({ session: sessionHandle.session, artifactsDir: artifactsBaseDir })

	validatePageIndicatorOptions(options.pageIndicator)
	const indicatorEnabled = options.pageIndicator?.enabled === true
	let indicatorController: PageIndicatorController | null = null
	let indicatorAttachedAt: number | null = null

	if (indicatorEnabled) {
		indicatorController = createPageIndicatorController(options.pageIndicator!)
	}

	const buildIndicatorInfo = (target: { title: string | null; url: string | null } | null) => ({
		watcherId: options.id,
		watcherHost: host,
		watcherPort: record.port,
		watcherPid: process.pid,
		targetTitle: target?.title ?? null,
		targetUrl: target?.url ?? null,
		attachedAt: indicatorAttachedAt ?? Date.now(),
	})

	const cdp = startCdpWatcher({
		sessionHandle,
		chrome,
		match: options.match,
		ignoreMatcher,
		stripUrlPrefixes,
		onLog: (event) => {
			buffer.add(event)
			fileLogger?.writeEvent(event)
		},
		onPageNavigation: (info) => {
			fileLogger?.rotate(info)
			if (indicatorController) {
				indicatorController.onNavigation(sessionHandle.session, buildIndicatorInfo({ title: null, url: info.url }))
			}
		},
		onPageIntl: (info) => {
			fileLogger?.setPageIntl(info)
		},
		onAttach: async (session, target) => {
			await networkCapture?.onAttached()
			if (indicatorController) {
				indicatorAttachedAt = Date.now()
				indicatorController.onAttach(session, target, buildIndicatorInfo({ title: target.title, url: target.url }))
			}
		},
		onDetach: (reason) => {
			networkCapture?.onDetached()
			traceRecorder.onDetached(reason)
			indicatorController?.onDetach()
		},
		onStatus: (status) => {
			const prevAttached = cdpStatus.attached
			cdpStatus = status

			if (status.attached && !prevAttached) {
				const url = status.target?.url ?? 'unknown'
				logToPageConsole(`attached (url=${url})`)
				void events.emit('cdpAttached', {
					ts: Date.now(),
					watcherId: options.id,
					target: status.target,
				})
			} else if (!status.attached && prevAttached) {
				void events.emit('cdpDetached', {
					ts: Date.now(),
					watcherId: options.id,
					target: status.target,
					reason: status.reason ?? 'unknown',
				})
			}
		},
	})

	const server = await startHttpServer({
		host,
		port,
		buffer,
		netBuffer,
		getWatcher: () => record,
		getCdpStatus: () => cdpStatus,
		cdpSession: sessionHandle.session,
		traceRecorder,
		screenshotter,
		onRequest: (event) => {
			if (pageConsoleLogging === 'full') {
				logToPageConsole(`http ${event.endpoint}`)
			}
			void events.emit('httpRequested', {
				...event,
				watcherId: options.id,
			})
		},
		onShutdown: () => {
			if (!readyForShutdown || !closeOnce) {
				shutdownRequested = true
				return
			}
			void closeOnce()
		},
	})

	record.port = server.port
	await announceWatcher(record)

	const heartbeat = startRegistryHeartbeat(() => record, options.heartbeatMs ?? 15_000)
	closeOnce = async () => {
		if (closing) {
			return
		}
		closing = true
		heartbeat.stop()
		indicatorController?.stop()
		if (cdpStatus.attached) {
			logToPageConsole('detached (reason=watcher_stopped)')
		}
		await cdp.stop()
		await fileLogger?.close()
		traceRecorder.onDetached('watcher_stopped')
		await server.close()
		await removeWatcher(record.id)
		events.clearListeners()
	}
	readyForShutdown = true
	if (shutdownRequested) {
		void closeOnce()
	}

	return {
		watcher: record,
		events,
		close: async () => {
			await closeOnce?.()
		},
	}
}

/** Log event shape emitted by watchers. */
export type { LogEvent }

export type { ArgusWatcherEventMap, CdpAttachedEvent, CdpDetachedEvent, HttpRequestEvent, LogRequestQuery, NetRequestQuery } from './events.js'

export type { PageIndicatorOptions, PageIndicatorPosition } from './cdp/pageIndicator.js'

const resolveArtifactsBaseDir = (base: string | undefined): string => {
	if (base !== undefined && base !== null) {
		if (typeof base !== 'string' || base.trim() === '') {
			throw new Error('artifacts.base must be a non-empty string when provided')
		}
		return path.resolve(base)
	}
	return path.resolve(process.cwd(), 'argus-artifacts')
}

const resolveMaxFiles = (maxFiles?: number): number => {
	if (maxFiles === undefined) {
		return 5
	}
	if (!Number.isInteger(maxFiles) || maxFiles < 1) {
		throw new Error('artifacts.logs.maxFiles must be an integer >= 1')
	}
	return maxFiles
}
