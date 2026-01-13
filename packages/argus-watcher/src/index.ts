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
	/** Optional file log persistence settings. */
	fileLogs?: {
		/** Directory to store watcher logs. Required when fileLogs is set. */
		logsDir: string
		/** Max number of log files to keep for this watcher. Defaults to `5`. */
		maxFiles?: number
		/** Optional callback to customize the log filename. Return null/undefined to use default. */
		buildFilename?: (context: BuildFilenameContext) => string | undefined | null
	}
	/** Optional ignore list filtering when selecting log/exception locations. */
	ignoreList?: {
		/** Enable ignore list filtering for log/exception locations. */
		enabled?: boolean
		/** Regex patterns (as strings) to ignore when selecting a stack frame. */
		rules?: string[]
	}
	/** Whether to include ISO timestamps in log records. Defaults to `false`. */
	includeTimestamps?: boolean
	/** Base directory for trace/screenshot artifacts. Defaults to fileLogs.logsDir when set. */
	artifactsDir?: string
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
}

/** Handle returned by startWatcher. */
export type WatcherHandle = {
	close: () => Promise<void>
	watcher: WatcherRecord
	/**
	 * Event emitter for watcher lifecycle and request events.
	 * Subscribe to 'cdpAttached', 'cdpDetached', and 'httpRequested'.
	 */
	events: Emittery<ArgusWatcherEventMap>
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
	const includeTimestamps = options.includeTimestamps ?? false
	const ignoreMatcher = buildIgnoreMatcher(options.ignoreList)
	const stripUrlPrefixes = options.location?.stripUrlPrefixes

	const events = new Emittery<ArgusWatcherEventMap>()
	const buffer = new LogBuffer(bufferSize)
	const netBuffer = new NetBuffer(netBufferSize)
	let cdpStatus: {
		attached: boolean
		target: { title: string | null; url: string | null } | null
		reason?: string | null
	} = { attached: false, target: null }
	const fileLogs = options.fileLogs
	const logsDir = fileLogs ? resolveLogsDir(fileLogs.logsDir) : null
	const artifactsDir = resolveArtifactsDir(options.artifactsDir, logsDir)
	const maxFiles = fileLogs ? resolveMaxFiles(fileLogs.maxFiles) : null
	const fileLogger = logsDir
		? new WatcherFileLogger({
				watcherId: options.id,
				startedAt,
				logsDir,
				chrome,
				match: options.match,
				maxFiles: maxFiles ?? 5,
				includeTimestamps,
				buildFilename: fileLogs?.buildFilename,
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
	const networkCapture = createNetworkCapture({ session: sessionHandle.session, buffer: netBuffer })
	const traceRecorder = createTraceRecorder({ session: sessionHandle.session, artifactsDir })
	const screenshotter = createScreenshotter({ session: sessionHandle.session, artifactsDir })

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
			await networkCapture.onAttached()
			if (indicatorController) {
				indicatorAttachedAt = Date.now()
				indicatorController.onAttach(session, target, buildIndicatorInfo({ title: target.title, url: target.url }))
			}
		},
		onDetach: (reason) => {
			networkCapture.onDetached()
			traceRecorder.onDetached(reason)
			indicatorController?.onDetach()
		},
		onStatus: (status) => {
			const prevAttached = cdpStatus.attached
			cdpStatus = status

			if (status.attached && !prevAttached) {
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
			void events.emit('httpRequested', {
				...event,
				watcherId: options.id,
			})
		},
	})

	record.port = server.port
	await announceWatcher(record)

	const heartbeat = startRegistryHeartbeat(() => record, options.heartbeatMs ?? 15_000)

	return {
		watcher: record,
		events,
		close: async () => {
			heartbeat.stop()
			indicatorController?.stop()
			await cdp.stop()
			await fileLogger?.close()
			traceRecorder.onDetached('watcher_stopped')
			await server.close()
			await removeWatcher(record.id)
			events.clearListeners()
		},
	}
}

/** Log event shape emitted by watchers. */
export type { LogEvent }

export type {
	ArgusWatcherEventMap,
	CdpAttachedEvent,
	CdpDetachedEvent,
	HttpRequestEvent,
	LogRequestQuery,
	NetRequestQuery,
} from './events.js'

export type { PageIndicatorOptions, PageIndicatorPosition } from './cdp/pageIndicator.js'

const resolveLogsDir = (logsDir: string): string => {
	if (typeof logsDir !== 'string' || logsDir.trim() === '') {
		throw new Error('fileLogs.logsDir is required')
	}
	return path.resolve(logsDir)
}

const resolveMaxFiles = (maxFiles?: number): number => {
	if (maxFiles === undefined) {
		return 5
	}
	if (!Number.isInteger(maxFiles) || maxFiles < 1) {
		throw new Error('fileLogs.maxFiles must be an integer >= 1')
	}
	return maxFiles
}

const resolveArtifactsDir = (artifactsDir: string | undefined, logsDir: string | null): string => {
	if (artifactsDir && artifactsDir.trim() !== '') {
		return path.resolve(artifactsDir)
	}
	if (logsDir) {
		return path.resolve(logsDir)
	}
	return path.resolve(process.cwd(), 'argus-artifacts')
}
