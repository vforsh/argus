import type { WatcherRecord } from '@vforsh/argus-core'
import type { CdpSessionHandle } from '../cdp/connection.js'
import { createPageIndicatorController, validatePageIndicatorOptions, type PageIndicatorOptions } from '../cdp/pageIndicator.js'
import type { CdpSourceStatus } from '../sources/types.js'

/** Target shape the source reports on attach and target change. */
type IndicatorTarget = { id: string; title: string; url: string; type?: string | null; parentId?: string | null }

/**
 * The runtime's view of the on-page indicator: four callbacks, all no-ops when it is disabled.
 *
 * Every method is safe to call unconditionally, which is the point — the runtime used to guard each
 * one with its own `if (!indicatorController) return`.
 */
export type IndicatorBinding = {
	onNavigation: (session: CdpSessionHandle, info: { url: string }) => void
	onLoad: () => void
	onAttach: (session: CdpSessionHandle, target: IndicatorTarget) => void
	onDetach: () => void
	setRecording: (recording: boolean) => void
	stop: () => void
}

/**
 * Bind the page indicator to one watcher's lifecycle.
 *
 * @param record Live watcher record; `port` is read at call time because it is assigned only once
 *   the HTTP server binds.
 * @param getCdpStatus Current attachment, so a parent-page navigation keeps showing the selected
 *   iframe rather than overwriting the modal with stale top-level metadata.
 * @throws When `pageIndicator` options are malformed — validated here so a bad config fails at
 *   startup rather than on first navigation.
 */
export const createIndicatorBinding = (input: {
	options: PageIndicatorOptions | undefined
	record: WatcherRecord
	getCdpStatus: () => CdpSourceStatus
}): IndicatorBinding => {
	validatePageIndicatorOptions(input.options)
	const controller = input.options?.enabled === true ? createPageIndicatorController(input.options) : null
	let attachedAt: number | null = null

	const buildInfo = (target: { title: string | null; url: string | null } | null) => ({
		watcherId: input.record.id,
		watcherHost: input.record.host,
		watcherPort: input.record.port,
		watcherPid: process.pid,
		targetTitle: target?.title ?? null,
		targetUrl: target?.url ?? null,
		attachedAt: attachedAt ?? Date.now(),
	})

	return {
		onNavigation: (session, info) => {
			if (!controller) {
				return
			}
			const status = input.getCdpStatus()
			const target = status.attached ? { title: status.target?.title ?? null, url: status.target?.url ?? info.url } : { title: null, url: info.url }
			controller.onNavigation(session, buildInfo(target))
		},
		onLoad: () => {
			controller?.reinstall()
		},
		onAttach: (session, target) => {
			if (!controller) {
				return
			}
			attachedAt = Date.now()
			controller.onAttach(
				session,
				{
					id: target.id,
					title: target.title,
					url: target.url,
					type: target.type ?? 'page',
					parentId: target.parentId ?? null,
					webSocketDebuggerUrl: '',
				},
				buildInfo({ title: target.title, url: target.url }),
			)
		},
		onDetach: () => {
			controller?.onDetach()
		},
		setRecording: (recording) => {
			controller?.setRecording(recording)
		},
		stop: () => {
			controller?.stop()
		},
	}
}
