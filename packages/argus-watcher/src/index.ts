import type { WatcherMatch, WatcherChrome, WatcherRecord, LogEvent } from '@vforsh/argus-core'
import os from 'node:os'
import path from 'node:path'
import Emittery from 'emittery'
import { LogBuffer } from './buffer/LogBuffer.js'
import { NetBuffer } from './buffer/NetBuffer.js'
import { startHttpServer } from './http/server.js'
import { announceWatcher, removeWatcher, startRegistryHeartbeat, ensureUniqueWatcherId } from './registry/registry.js'
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
import { createEmulationController } from './emulation/EmulationController.js'
import { createCdpSource } from './sources/cdp-source.js'
import { createExtensionSource } from './sources/extension-source.js'
import type { CdpSourceHandle, CdpSourceStatus } from './sources/types.js'
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
	 * Only supported in CDP mode.
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

	await ensureUniqueWatcherId(options.id)

	const sourceMode = options.source ?? 'cdp'
	const host = options.host ?? '127.0.0.1'
	const port = options.port ?? 0
	const chrome = options.chrome ?? { host: '127.0.0.1', port: 9222 }
	const bufferSize = options.bufferSize ?? 50_000
	const netBufferSize = options.bufferSize ?? 50_000
	const startedAt = Date.now()
	const ignoreMatcher = buildIgnoreMatcher(options.ignoreList)
	const stripUrlPrefixes = options.location?.stripUrlPrefixes

	// Resolve artifacts configuration
	const artifactsBaseDir = resolveArtifactsBaseDir(options.artifacts?.base, options.id)
	const logsEnabled = options.artifacts?.logs?.enabled === true
	const logsDir = path.join(artifactsBaseDir, 'logs')
	const includeTimestamps = options.artifacts?.logs?.includeTimestamps ?? false
	const maxFiles = resolveMaxFiles(options.artifacts?.logs?.maxFiles)

	// Network capture is opt-in (disabled by default) and only in CDP mode
	const netEnabled = sourceMode === 'cdp' && options.net?.enabled === true

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
	let cdpStatus: CdpSourceStatus = { attached: false, target: null }

	const fileLogger = logsEnabled
		? new WatcherFileLogger({
				watcherId: options.id,
				startedAt,
				logsDir,
				chrome: sourceMode === 'cdp' ? chrome : undefined,
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
		match: sourceMode === 'cdp' ? options.match : undefined,
		chrome: sourceMode === 'cdp' ? chrome : undefined,
		includeTimestamps,
		source: sourceMode,
	}

	// Create session handle for CDP mode (used by network capture, tracing, etc.)
	const sessionHandle = createCdpSessionHandle()

	// Emulation controller (shared across CDP and extension modes)
	const emulationController = createEmulationController()

	const logToPageConsole = (message: string): void => {
		if (pageConsoleLogging === 'none') {
			return
		}
		if (!sourceHandle?.session.isAttached()) {
			return
		}
		const fullMessage = `[ARGUS] ${watcherId} :: ${message}`
		queueMicrotask(() => {
			sourceHandle?.session
				.sendAndWait('Runtime.evaluate', {
					expression: `console.log(${JSON.stringify(fullMessage)})`,
					silent: true,
				})
				.catch(() => {})
		})
	}

	// Page indicator only supported in CDP mode
	validatePageIndicatorOptions(options.pageIndicator)
	const indicatorEnabled = sourceMode === 'cdp' && options.pageIndicator?.enabled === true
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

	const maybeInjectOnAttach = async (
		session: CdpSourceHandle['session'],
		target: { title?: string | null; url?: string | null; type?: string | null; parentId?: string | null },
	): Promise<void> => {
		if (!options.inject?.script) {
			return
		}
		if (!session.isAttached()) {
			return
		}

		const trimmedScript = options.inject.script.trim()
		if (trimmedScript === '') {
			console.warn(`[Watcher] Inject script is empty for watcher ${record.id}. Skipping.`)
			return
		}

		const attachedAt = Date.now()
		const exposeArgus = options.inject.exposeArgus ?? true
		const argusPayload = exposeArgus
			? {
					watcherId: record.id,
					watcherHost: record.host,
					watcherPort: record.port,
					watcherPid: record.pid,
					attachedAt,
					target: {
						title: target.title ?? null,
						url: target.url ?? null,
						type: target.type ?? 'page',
						parentId: target.parentId ?? null,
					},
				}
			: null

		const expression = buildInjectExpression(trimmedScript, argusPayload)

		try {
			await session.sendAndWait('Page.addScriptToEvaluateOnNewDocument', { source: expression })
		} catch (error) {
			console.warn(`[Watcher] Failed to register inject script for watcher ${record.id}: ${formatError(error)}`)
		}

		try {
			await session.sendAndWait('Runtime.evaluate', { expression, silent: true })
		} catch (error) {
			console.warn(`[Watcher] Failed to run inject script for watcher ${record.id}: ${formatError(error)}`)
		}
	}

	// Create the appropriate source based on mode
	let sourceHandle: CdpSourceHandle
	let networkCapture: Awaited<ReturnType<typeof createNetworkCapture>> | null = null
	let traceRecorder: ReturnType<typeof createTraceRecorder>
	let screenshotter: ReturnType<typeof createScreenshotter>

	if (sourceMode === 'extension') {
		// Extension mode
		sourceHandle = createExtensionSource({
			events: {
				onLog: (event) => {
					buffer.add(event)
					fileLogger?.writeEvent(event)
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
				onPageNavigation: (info) => {
					fileLogger?.rotate(info)
				},
				onPageIntl: (info) => {
					fileLogger?.setPageIntl(info)
				},
				onAttach: async (session, target) => {
					await emulationController.onAttach(session)
					await maybeInjectOnAttach(session, target)
				},
			},
			ignoreMatcher: ignoreMatcher ? (url: string) => ignoreMatcher.matches(url) : null,
			stripUrlPrefixes,
		})

		// Create trace/screenshot with proxy session
		traceRecorder = createTraceRecorder({ session: sourceHandle.session, artifactsDir: artifactsBaseDir })
		screenshotter = createScreenshotter({ session: sourceHandle.session, artifactsDir: artifactsBaseDir })
	} else {
		// CDP mode
		networkCapture = netBuffer ? createNetworkCapture({ session: sessionHandle.session, buffer: netBuffer }) : null
		traceRecorder = createTraceRecorder({ session: sessionHandle.session, artifactsDir: artifactsBaseDir })
		screenshotter = createScreenshotter({ session: sessionHandle.session, artifactsDir: artifactsBaseDir })

		sourceHandle = createCdpSource({
			chrome,
			match: options.match,
			sessionHandle,
			events: {
				onLog: (event) => {
					buffer.add(event)
					fileLogger?.writeEvent(event)
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
				onPageNavigation: (info) => {
					fileLogger?.rotate(info)
					if (indicatorController) {
						indicatorController.onNavigation(sessionHandle.session, buildIndicatorInfo({ title: null, url: info.url }))
					}
				},
				onPageLoad: () => {
					if (indicatorController) {
						indicatorController.reinstall()
					}
				},
				onPageIntl: (info) => {
					fileLogger?.setPageIntl(info)
				},
				onAttach: async (session, target) => {
					await emulationController.onAttach(session)
					await networkCapture?.onAttached()
					if (indicatorController) {
						indicatorAttachedAt = Date.now()
						indicatorController.onAttach(
							session,
							{
								id: target.id,
								title: target.title,
								url: target.url,
								type: target.type ?? 'page',
								parentId: target.parentId ?? null,
								webSocketDebuggerUrl: '',
							},
							buildIndicatorInfo({ title: target.title, url: target.url }),
						)
					}
					await maybeInjectOnAttach(session, target)
				},
				onDetach: (reason) => {
					networkCapture?.onDetached()
					traceRecorder.onDetached(reason)
					indicatorController?.onDetach()
				},
			},
			ignoreMatcher: ignoreMatcher ? (url: string) => ignoreMatcher.matches(url) : null,
			stripUrlPrefixes,
		})
	}

	const server = await startHttpServer({
		host,
		port,
		buffer,
		netBuffer,
		getWatcher: () => record,
		getCdpStatus: () => cdpStatus,
		cdpSession: sourceHandle.session,
		traceRecorder,
		screenshotter,
		emulationController,
		// Extension mode endpoints
		sourceHandle: sourceMode === 'extension' ? sourceHandle : undefined,
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
		await sourceHandle.stop()
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

const resolveArtifactsBaseDir = (base: string | undefined, watcherId: string): string => {
	if (base !== undefined && base !== null) {
		if (typeof base !== 'string' || base.trim() === '') {
			throw new Error('artifacts.base must be a non-empty string when provided')
		}
		return path.resolve(base)
	}
	return path.join(os.tmpdir(), 'argus', watcherId)
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

const buildInjectExpression = (
	script: string,
	argusPayload: {
		watcherId: string
		watcherHost: string
		watcherPort: number
		watcherPid: number
		attachedAt: number
		target: { title: string | null; url: string | null; type: string; parentId: string | null }
	} | null,
): string => {
	const lines = ['(() => {']
	if (argusPayload) {
		lines.push(`window.__ARGUS__ = ${JSON.stringify(argusPayload)};`)
	}
	lines.push(`const __argusScript = ${JSON.stringify(script)};`)
	lines.push('const __argusFn = new Function(__argusScript);')
	lines.push('__argusFn();')
	lines.push('})();')
	return lines.join('\n')
}

const formatError = (error: unknown): string => {
	if (!error) {
		return 'Unknown error'
	}
	if (error instanceof Error) {
		return error.message
	}
	return String(error)
}
