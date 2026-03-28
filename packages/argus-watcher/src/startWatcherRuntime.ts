import type { WatcherChrome, WatcherRecord, LogEvent } from '@vforsh/argus-core'
import os from 'node:os'
import path from 'node:path'
import Emittery from 'emittery'
import { LogBuffer } from './buffer/LogBuffer.js'
import { NetBuffer } from './buffer/NetBuffer.js'
import { startHttpServer } from './http/server.js'
import { announceWatcher, removeWatcher, startRegistryHeartbeat } from './registry/registry.js'
import { WatcherFileLogger } from './fileLogs/WatcherFileLogger.js'
import { buildIgnoreMatcher } from './cdp/ignoreList.js'
import { createNetworkCapture } from './cdp/networkCapture.js'
import { createTraceRecorder } from './cdp/tracing.js'
import { createScreenshotter } from './cdp/screenshot.js'
import { createRuntimeEditor } from './cdp/editor.js'
import { createCdpSessionHandle } from './cdp/connection.js'
import { createPageIndicatorController, validatePageIndicatorOptions, type PageIndicatorController } from './cdp/pageIndicator.js'
import { createEmulationController } from './emulation/EmulationController.js'
import { createThrottleController } from './throttle/ThrottleController.js'
import { createCdpSource } from './sources/cdp-source.js'
import { createExtensionSource } from './sources/extension-source.js'
import type { CdpSourceHandle, CdpSourceStatus, CdpSourceTarget } from './sources/types.js'
import type { ArgusWatcherEventMap } from './events.js'
import type { StartWatcherOptions, WatcherHandle } from './index.js'

type NormalizedWatcherSetup = {
	sourceMode: NonNullable<StartWatcherOptions['source']>
	host: string
	port: number
	chrome: WatcherChrome
	watcherId: string
	startedAt: number
	artifactsBaseDir: string
	includeTimestamps: boolean
	netEnabled: boolean
	pageConsoleLogging: NonNullable<StartWatcherOptions['pageConsoleLogging']>
	ignoreMatcher: ReturnType<typeof buildIgnoreMatcher>
	stripUrlPrefixes: string[] | undefined
	events: Emittery<ArgusWatcherEventMap>
	buffer: LogBuffer
	netBuffer: NetBuffer | null
	record: WatcherRecord
	fileLogger: WatcherFileLogger | null
	sessionHandle: ReturnType<typeof createCdpSessionHandle>
	emulationController: ReturnType<typeof createEmulationController>
	throttleController: ReturnType<typeof createThrottleController>
}

/**
 * Build the watcher runtime and keep the public entrypoint focused on API shape and input validation.
 */
export const createWatcherHandle = async (options: StartWatcherOptions, watcherId: string): Promise<WatcherHandle> => {
	const setup = normalizeWatcherSetup(options, watcherId)
	const {
		sourceMode,
		host,
		port,
		chrome,
		artifactsBaseDir,
		pageConsoleLogging,
		ignoreMatcher,
		stripUrlPrefixes,
		events,
		buffer,
		netBuffer,
		record,
		fileLogger,
		sessionHandle,
		emulationController,
		throttleController,
	} = setup
	let closing = false
	let readyForShutdown = false
	let shutdownRequested = false
	let closeOnce: (() => Promise<void>) | null = null
	let cdpStatus: CdpSourceStatus = { attached: false, target: null }

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

	validatePageIndicatorOptions(options.pageIndicator)
	const indicatorEnabled = options.pageIndicator?.enabled === true
	let indicatorController: PageIndicatorController | null = null
	let indicatorAttachedAt: number | null = null

	if (indicatorEnabled) {
		indicatorController = createPageIndicatorController(options.pageIndicator!)
	}

	const updateCdpStatus = (status: CdpSourceStatus): void => {
		const prevAttached = cdpStatus.attached
		cdpStatus = status

		if (status.attached && !prevAttached) {
			const url = status.target?.url ?? 'unknown'
			logToPageConsole(`attached (url=${url})`)
			void events.emit('cdpAttached', {
				ts: Date.now(),
				watcherId,
				target: status.target,
			})
			return
		}

		if (!status.attached && prevAttached) {
			void events.emit('cdpDetached', {
				ts: Date.now(),
				watcherId,
				target: status.target,
				reason: status.reason ?? 'unknown',
			})
		}
	}

	const buildIndicatorInfo = (target: { title: string | null; url: string | null } | null) => ({
		watcherId,
		watcherHost: host,
		watcherPort: record.port,
		watcherPid: process.pid,
		targetTitle: target?.title ?? null,
		targetUrl: target?.url ?? null,
		attachedAt: indicatorAttachedAt ?? Date.now(),
	})

	const onIndicatorNavigation = (session: CdpSourceHandle['session'], info: { url: string }): void => {
		if (!indicatorController) {
			return
		}
		indicatorController.onNavigation(session, buildIndicatorInfo({ title: null, url: info.url }))
	}

	const onIndicatorLoad = (): void => {
		indicatorController?.reinstall()
	}

	const getIndicatorSession = (): CdpSourceHandle['session'] => sourceHandle.pageSession ?? sourceHandle.session

	const onIndicatorAttach = (
		session: CdpSourceHandle['session'],
		target: { id: string; title: string; url: string; type?: string | null; parentId?: string | null },
	): void => {
		if (!indicatorController) {
			return
		}

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

	const handleSourceLog = (event: Omit<LogEvent, 'id'>): void => {
		buffer.add(event)
		fileLogger?.writeEvent(event)
	}

	const handlePageNavigation = (info: { url: string; title: string | null }): void => {
		fileLogger?.rotate(info)
		onIndicatorNavigation(getIndicatorSession(), info)
		runtimeEditor?.reset()
	}

	const handlePageIntl = (info: { timezone: string | null; locale: string | null }): void => {
		fileLogger?.setPageIntl(info)
	}

	const handleSourceAttach = async (session: CdpSourceHandle['session'], target: CdpSourceTarget): Promise<void> => {
		runtimeEditor?.rebind()
		await emulationController.onAttach(session)
		await throttleController.onAttach(session)
		await networkCapture?.onAttached()
		onIndicatorAttach(session, target)
		await maybeInjectOnAttach(session, target)
	}

	const handleTargetChanged = (
		session: CdpSourceHandle['session'],
		target: { id: string; title: string; url: string; type?: string | null; parentId?: string | null },
	): void => {
		onIndicatorAttach(session, target)
	}

	const handleSourceDetach = (reason?: string): void => {
		runtimeEditor?.rebind()
		networkCapture?.onDetached()
		indicatorController?.onDetach()
		if (reason != null) {
			traceRecorder.onDetached(reason)
		}
	}

	let sourceHandle: CdpSourceHandle
	let networkCapture: Awaited<ReturnType<typeof createNetworkCapture>> | null = null
	let traceRecorder: ReturnType<typeof createTraceRecorder>
	let screenshotter: ReturnType<typeof createScreenshotter>
	let runtimeEditor: ReturnType<typeof createRuntimeEditor>

	if (sourceMode === 'extension') {
		sourceHandle = createExtensionSource({
			events: {
				onLog: handleSourceLog,
				onStatus: updateCdpStatus,
				onPageNavigation: handlePageNavigation,
				onPageLoad: onIndicatorLoad,
				onPageIntl: handlePageIntl,
				onAttach: handleSourceAttach,
				onTargetChanged: handleTargetChanged,
				onDetach: () => {
					handleSourceDetach()
				},
			},
			watcherId,
			watcherHost: host,
			watcherPort: record.port,
			ignoreMatcher: ignoreMatcher ? (url: string) => ignoreMatcher.matches(url) : null,
			stripUrlPrefixes,
		})

		networkCapture = netBuffer ? createNetworkCapture({ session: sourceHandle.pageSession ?? sourceHandle.session, buffer: netBuffer }) : null
		traceRecorder = createTraceRecorder({ session: sourceHandle.session, artifactsDir: artifactsBaseDir })
		screenshotter = createScreenshotter({ session: sourceHandle.session, artifactsDir: artifactsBaseDir })
		runtimeEditor = createRuntimeEditor(sourceHandle.session)
	} else {
		networkCapture = netBuffer ? createNetworkCapture({ session: sessionHandle.session, buffer: netBuffer }) : null
		traceRecorder = createTraceRecorder({ session: sessionHandle.session, artifactsDir: artifactsBaseDir })
		screenshotter = createScreenshotter({ session: sessionHandle.session, artifactsDir: artifactsBaseDir })
		runtimeEditor = createRuntimeEditor(sessionHandle.session)

		sourceHandle = createCdpSource({
			chrome,
			match: options.match,
			sessionHandle,
			events: {
				onLog: handleSourceLog,
				onStatus: updateCdpStatus,
				onPageNavigation: handlePageNavigation,
				onPageLoad: onIndicatorLoad,
				onPageIntl: handlePageIntl,
				onAttach: handleSourceAttach,
				onDetach: (reason) => {
					handleSourceDetach(reason)
				},
			},
			watcherId,
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
		pageCdpSession: sourceHandle.pageSession ?? sourceHandle.session,
		cdpSession: sourceHandle.session,
		traceRecorder,
		screenshotter,
		runtimeEditor,
		emulationController,
		throttleController,
		sourceHandle: sourceMode === 'extension' ? sourceHandle : undefined,
		onRequest: (event) => {
			if (pageConsoleLogging === 'full') {
				logToPageConsole(`http ${event.endpoint}`)
			}
			void events.emit('httpRequested', {
				...event,
				watcherId,
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
	sourceHandle.syncWatcherInfo?.({
		watcherId,
		watcherHost: host,
		watcherPort: record.port,
		watcherPid: process.pid,
	})
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

const normalizeWatcherSetup = (options: StartWatcherOptions, watcherId: string): NormalizedWatcherSetup => {
	const sourceMode = options.source ?? 'cdp'
	const host = options.host ?? '127.0.0.1'
	const port = options.port ?? 0
	const chrome = options.chrome ?? { host: '127.0.0.1', port: 9222 }
	const bufferSize = options.bufferSize ?? 50_000
	const startedAt = Date.now()
	const ignoreMatcher = buildIgnoreMatcher(options.ignoreList)
	const stripUrlPrefixes = options.location?.stripUrlPrefixes
	const artifactsBaseDir = resolveArtifactsBaseDir(options.artifacts?.base, watcherId)
	const logsEnabled = options.artifacts?.logs?.enabled === true
	const logsDir = path.join(artifactsBaseDir, 'logs')
	const includeTimestamps = options.artifacts?.logs?.includeTimestamps ?? false
	const maxFiles = resolveMaxFiles(options.artifacts?.logs?.maxFiles)
	const netEnabled = options.net?.enabled === true
	const pageConsoleLogging = options.pageConsoleLogging ?? 'minimal'
	const events = new Emittery<ArgusWatcherEventMap>()
	const buffer = new LogBuffer(bufferSize)
	const netBuffer = netEnabled ? new NetBuffer(bufferSize) : null
	const fileLogger = logsEnabled
		? new WatcherFileLogger({
				watcherId,
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
		id: watcherId,
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

	return {
		sourceMode,
		host,
		port,
		chrome,
		watcherId,
		startedAt,
		artifactsBaseDir,
		includeTimestamps,
		netEnabled,
		pageConsoleLogging,
		ignoreMatcher,
		stripUrlPrefixes,
		events,
		buffer,
		netBuffer,
		record,
		fileLogger,
		sessionHandle: createCdpSessionHandle(),
		emulationController: createEmulationController(),
		throttleController: createThrottleController(),
	}
}

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
