import type { DialogStatus, LogEvent } from '@vforsh/argus-core'
import { startHttpServer } from './http/server.js'
import { announceWatcher, removeWatcher, startRegistryHeartbeat } from './registry/registry.js'

import { ElementRefRegistry } from './cdp/elementRefs.js'
import { DialogTracker } from './dialogs/DialogTracker.js'
import type { CdpSourceHandle, CdpSourceStatus, CdpSourceTarget } from './sources/types.js'
import type { StartWatcherOptions, WatcherHandle } from './index.js'
import { createInjectOnAttach } from './runtime/watcherInject.js'
import { createIndicatorBinding } from './runtime/watcherIndicator.js'
import { createShutdownLatch } from './runtime/shutdownLatch.js'
import { normalizeWatcherSetup } from './runtime/watcherSetup.js'
import { createWatcherRuntimeServices } from './runtime/watcherServices.js'

/**
 * Build the watcher runtime and keep the public entrypoint focused on API shape and input validation.
 */
export const createWatcherHandle = async (options: StartWatcherOptions, watcherId: string): Promise<WatcherHandle> => {
	const setup = normalizeWatcherSetup(options, watcherId)
	const {
		sourceMode,
		host,
		port,
		pageConsoleLogging,
		sourcemaps,
		events,
		buffer,
		netBuffer,
		realtimeNetBuffer,
		record,
		fileLogger,
		emulationController,
		throttleController,
		visibilityController,
		netMockController,
	} = setup
	const shutdown = createShutdownLatch()
	let cdpStatus: CdpSourceStatus = { attached: false, target: null }
	let pageNavigations = 0
	const dialogTracker = new DialogTracker()
	const elementRefs = new ElementRefRegistry()

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

	const indicator = createIndicatorBinding({ options: options.pageIndicator, record, getCdpStatus: () => cdpStatus })
	const injectOnAttach = createInjectOnAttach(options.inject, record)

	/** Dialogs, network capture, and the indicator all belong to the page, never to a selected iframe. */
	const getPageSession = (): CdpSourceHandle['session'] => sourceHandle.pageSession ?? sourceHandle.session

	const handleSourceLog = (event: Omit<LogEvent, 'id'>): void => {
		buffer.add(event)
		fileLogger?.writeEvent(event)
	}

	const handlePageNavigation = (info: { url: string; title: string | null }): void => {
		pageNavigations += 1
		elementRefs.reset()
		// A rebuilt bundle keeps its URL on most dev servers, so drop cached maps rather than
		// reporting locations from the previous build.
		sourcemaps.clear()
		fileLogger?.rotate(info)
		indicator.onNavigation(getPageSession(), info)
		runtimeEditor?.reset()
	}

	const handlePageIntl = (info: { timezone: string | null; locale: string | null }): void => {
		fileLogger?.setPageIntl(info)
	}

	const handleSourceAttach = async (session: CdpSourceHandle['session'], target: CdpSourceTarget): Promise<void> => {
		elementRefs.reset()
		dialogTracker.clear()
		runtimeEditor?.rebind()
		await emulationController.onAttach(session)
		await throttleController.onAttach(session)
		// Visibility lock is sticky across detaches; restore it before we
		// forward the attach to other services so downstream flows (boot
		// waits, indicator paints) benefit immediately.
		await visibilityController.onAttach(getPageSession())
		await netMockController.onAttach()
		await networkCapture?.onAttached()
		indicator.onAttach(session, target)
		await injectOnAttach(session, target)
	}

	const handleTargetChanged = (
		session: CdpSourceHandle['session'],
		target: { id: string; title: string; url: string; type?: string | null; parentId?: string | null },
	): void => {
		elementRefs.reset()
		updateCdpStatus({
			attached: true,
			target: {
				title: target.title ?? null,
				url: target.url ?? null,
				type: target.type ?? null,
				parentId: target.parentId ?? null,
			},
			reason: null,
		})
		void netMockController.onTargetChanged()
		indicator.onAttach(session, target)
	}

	const handleSourceDetach = (reason?: string): void => {
		elementRefs.reset()
		dialogTracker.clear()
		runtimeEditor?.rebind()
		networkCapture?.onDetached()
		netMockController.onDetach()
		indicator.onDetach()
		recorder.onDetached(reason)
		if (reason != null) {
			traceRecorder.onDetached(reason)
		}
	}

	const { sourceHandle, networkCapture, traceRecorder, screenshotter, recorder, runtimeEditor } = createWatcherRuntimeServices(options, setup, {
		onLog: handleSourceLog,
		onStatus: updateCdpStatus,
		onPageNavigation: handlePageNavigation,
		onPageLoad: indicator.onLoad,
		onPageIntl: handlePageIntl,
		onAttach: handleSourceAttach,
		onTargetChanged: handleTargetChanged,
		onDetach: handleSourceDetach,
		onRecordingStateChange: (recording) => {
			indicator.setRecording(recording)
		},
	})

	netMockController.bind({
		pageSession: getPageSession(),
		getSelectedTarget: () => {
			const context = sourceHandle.getNetFilterContext?.() ?? null
			const frameId = context?.selectedFrameId ?? null
			return {
				frameId,
				topFrameId: context?.topFrameId ?? null,
				sessionId: frameId ? (sourceHandle.getFrameSessionId?.(frameId) ?? null) : null,
			}
		},
	})

	const dialogSession = getPageSession()
	dialogSession.onEvent('Page.javascriptDialogOpening', (params) => {
		const dialog = parseDialogStatus(params)
		if (!dialog) {
			return
		}
		dialogTracker.open(dialog)
	})
	dialogSession.onEvent('Page.javascriptDialogClosed', () => {
		dialogTracker.close()
	})

	const server = await startHttpServer({
		host,
		port,
		buffer,
		netBuffer,
		realtimeNetBuffer,
		elementRefs,
		getWatcher: () => record,
		getCdpStatus: () => cdpStatus,
		getCounters: () => ({ pageNavigations }),
		getDialog: () => dialogTracker.getActive(),
		pageCdpSession: getPageSession(),
		cdpSession: sourceHandle.session,
		traceRecorder,
		screenshotter,
		recorder,
		runtimeEditor,
		emulationController,
		throttleController,
		visibilityController,
		netMockController,
		getNetFilterContext: sourceHandle.getNetFilterContext,
		readBrowserCookies: sourceHandle.readBrowserCookies,
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
			void shutdown.close()
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
	shutdown.arm(async () => {
		heartbeat.stop()
		indicator.stop()
		if (cdpStatus.attached) {
			logToPageConsole('detached (reason=watcher_stopped)')
		}
		await sourceHandle.stop()
		await fileLogger?.close()
		traceRecorder.onDetached('watcher_stopped')
		recorder.onDetached('watcher_stopped')
		await server.close()
		await removeWatcher(record.id)
		events.clearListeners()
	})

	return {
		watcher: record,
		events,
		close: shutdown.close,
	}
}

const parseDialogStatus = (params: unknown): DialogStatus | null => {
	const record = params as {
		type?: unknown
		message?: unknown
		defaultPrompt?: unknown
		url?: unknown
		hasBrowserHandler?: unknown
	}

	if (!isDialogType(record.type) || typeof record.message !== 'string') {
		return null
	}

	return {
		type: record.type,
		message: record.message,
		defaultPrompt: typeof record.defaultPrompt === 'string' ? record.defaultPrompt : null,
		url: typeof record.url === 'string' && record.url !== '' ? record.url : null,
		hasBrowserHandler: record.hasBrowserHandler === true,
		openedAt: Date.now(),
	}
}

const isDialogType = (value: unknown): value is DialogStatus['type'] =>
	value === 'alert' || value === 'confirm' || value === 'prompt' || value === 'beforeunload'
