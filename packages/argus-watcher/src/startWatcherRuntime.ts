import type { LogEvent } from '@vforsh/argus-core'
import { startHttpServer } from './http/server.js'
import { announceWatcher, removeWatcher, startRegistryHeartbeat } from './registry/registry.js'
import { createPageIndicatorController, validatePageIndicatorOptions, type PageIndicatorController } from './cdp/pageIndicator.js'
import type { CdpSourceHandle, CdpSourceStatus, CdpSourceTarget } from './sources/types.js'
import type { StartWatcherOptions, WatcherHandle } from './index.js'
import { buildInjectExpression, formatWatcherError } from './runtime/watcherInject.js'
import { normalizeWatcherSetup } from './runtime/watcherSetup.js'
import { createWatcherRuntimeServices } from './runtime/watcherServices.js'

/**
 * Build the watcher runtime and keep the public entrypoint focused on API shape and input validation.
 */
export const createWatcherHandle = async (options: StartWatcherOptions, watcherId: string): Promise<WatcherHandle> => {
	const setup = normalizeWatcherSetup(options, watcherId)
	const { sourceMode, host, port, pageConsoleLogging, events, buffer, netBuffer, record, fileLogger, emulationController, throttleController } =
		setup
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
			console.warn(`[Watcher] Failed to register inject script for watcher ${record.id}: ${formatWatcherError(error)}`)
		}

		try {
			await session.sendAndWait('Runtime.evaluate', { expression, silent: true })
		} catch (error) {
			console.warn(`[Watcher] Failed to run inject script for watcher ${record.id}: ${formatWatcherError(error)}`)
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

	const { sourceHandle, networkCapture, traceRecorder, screenshotter, runtimeEditor } = createWatcherRuntimeServices(options, setup, {
		onLog: handleSourceLog,
		onStatus: updateCdpStatus,
		onPageNavigation: handlePageNavigation,
		onPageLoad: onIndicatorLoad,
		onPageIntl: handlePageIntl,
		onAttach: handleSourceAttach,
		onTargetChanged: handleTargetChanged,
		onDetach: handleSourceDetach,
	})

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
