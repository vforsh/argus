import { createNetworkCapture } from '../cdp/networkCapture.js'
import { createTraceRecorder } from '../cdp/tracing.js'
import { createScreenshotter } from '../cdp/screenshot.js'
import { createRuntimeEditor } from '../cdp/editor.js'
import { createCdpSource } from '../sources/cdp-source.js'
import { createExtensionSource } from '../sources/extension-source.js'
import type { CdpSourceHandle, CdpSourceStatus, CdpSourceTarget } from '../sources/types.js'
import type { StartWatcherOptions } from '../index.js'
import type { NormalizedWatcherSetup } from './watcherSetup.js'

export type WatcherSourceCallbacks = {
	onLog: (event: Omit<import('@vforsh/argus-core').LogEvent, 'id'>) => void
	onStatus: (status: CdpSourceStatus) => void
	onPageNavigation: (info: { url: string; title: string | null }) => void
	onPageLoad: () => void
	onPageIntl: (info: { timezone: string | null; locale: string | null }) => void
	onAttach: (session: CdpSourceHandle['session'], target: CdpSourceTarget) => Promise<void>
	onTargetChanged?: (session: CdpSourceHandle['session'], target: CdpSourceTarget) => void
	onDetach: (reason?: string) => void
}

export type WatcherRuntimeServices = {
	sourceHandle: CdpSourceHandle
	networkCapture: Awaited<ReturnType<typeof createNetworkCapture>> | null
	traceRecorder: ReturnType<typeof createTraceRecorder>
	screenshotter: ReturnType<typeof createScreenshotter>
	runtimeEditor: ReturnType<typeof createRuntimeEditor>
}

export const createWatcherRuntimeServices = (
	options: StartWatcherOptions,
	setup: NormalizedWatcherSetup,
	callbacks: WatcherSourceCallbacks,
): WatcherRuntimeServices => {
	const { sourceMode, chrome, artifactsBaseDir, netBuffer, sessionHandle, ignoreMatcher, stripUrlPrefixes, watcherId, host, record } = setup

	if (sourceMode === 'extension') {
		const sourceHandle = createExtensionSource({
			events: {
				onLog: callbacks.onLog,
				onStatus: callbacks.onStatus,
				onPageNavigation: callbacks.onPageNavigation,
				onPageLoad: callbacks.onPageLoad,
				onPageIntl: callbacks.onPageIntl,
				onAttach: callbacks.onAttach,
				onTargetChanged: callbacks.onTargetChanged,
				onDetach: () => {
					callbacks.onDetach()
				},
			},
			watcherId,
			watcherHost: host,
			watcherPort: record.port,
			ignoreMatcher: ignoreMatcher ? (url: string) => ignoreMatcher.matches(url) : null,
			stripUrlPrefixes,
		})

		return {
			sourceHandle,
			networkCapture: netBuffer ? createNetworkCapture({ session: sourceHandle.pageSession ?? sourceHandle.session, buffer: netBuffer }) : null,
			traceRecorder: createTraceRecorder({ session: sourceHandle.session, artifactsDir: artifactsBaseDir }),
			screenshotter: createScreenshotter({ session: sourceHandle.session, artifactsDir: artifactsBaseDir }),
			runtimeEditor: createRuntimeEditor(sourceHandle.session),
		}
	}

	const sourceHandle = createCdpSource({
		chrome,
		match: options.match,
		sessionHandle,
		events: {
			onLog: callbacks.onLog,
			onStatus: callbacks.onStatus,
			onPageNavigation: callbacks.onPageNavigation,
			onPageLoad: callbacks.onPageLoad,
			onPageIntl: callbacks.onPageIntl,
			onAttach: callbacks.onAttach,
			onDetach: (reason) => {
				callbacks.onDetach(reason)
			},
		},
		watcherId,
		ignoreMatcher: ignoreMatcher ? (url: string) => ignoreMatcher.matches(url) : null,
		stripUrlPrefixes,
	})

	return {
		sourceHandle,
		networkCapture: netBuffer ? createNetworkCapture({ session: sessionHandle.session, buffer: netBuffer }) : null,
		traceRecorder: createTraceRecorder({ session: sessionHandle.session, artifactsDir: artifactsBaseDir }),
		screenshotter: createScreenshotter({ session: sessionHandle.session, artifactsDir: artifactsBaseDir }),
		runtimeEditor: createRuntimeEditor(sessionHandle.session),
	}
}
