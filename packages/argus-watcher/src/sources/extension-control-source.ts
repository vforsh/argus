import { createNativeMessaging } from '../native-messaging/messaging.js'
import { ControlSessionManager } from '../native-messaging/control-session-manager.js'
import type { ControlHostToExtension, ExtensionToControlHost } from '../native-messaging/types.js'
import type { CdpSourceHandle, CdpSourceBaseOptions } from './types.js'
import type { CdpSessionHandle } from '../cdp/connection.js'
import { parseExtensionTargetId } from './extension-frame-state.js'

/**
 * Create the extension-control source: a tab-less watcher that brokers
 * attach/detach requests and tab listings for the whole extension. It never
 * exposes a real CDP session; commands that need one fail with
 * `cdp_not_attached`.
 */
export const createControlExtensionSource = (options: CdpSourceBaseOptions): CdpSourceHandle => {
	const { events, watcherId, watcherHost, watcherPort } = options
	const messaging = createNativeMessaging<ExtensionToControlHost, ControlHostToExtension>()
	const controlSession = new ControlSessionManager(messaging)
	const hostInfo = {
		watcherId: watcherId ?? 'extension-control',
		watcherHost: watcherHost ?? '127.0.0.1',
		watcherPort: watcherPort ?? 0,
		watcherPid: process.pid,
	}
	let stopping = false

	messaging.start()
	messaging.send({ type: 'host_ready' })
	sendHostInfo()
	events.onStatus({
		attached: false,
		target: null,
		reason: 'control_watcher',
	})
	messaging.onDisconnect(() => {
		console.error('[ExtensionControlSource] Extension disconnected')
		if (!stopping) {
			events.onStatus({ attached: false, target: null, reason: 'extension_disconnected' })
			events.onDetach?.('extension_disconnected')
		}
	})

	return {
		session: createDetachedSession('Extension control watcher does not expose a CDP tab session'),
		syncWatcherInfo: (info) => {
			hostInfo.watcherId = info.watcherId
			hostInfo.watcherHost = info.watcherHost
			hostInfo.watcherPort = info.watcherPort
			hostInfo.watcherPid = info.watcherPid
			sendHostInfo()
		},
		stop: async () => {
			stopping = true
			messaging.stop()
		},
		listTargets: async () => [],
		listTabs: async (filter) => await controlSession.listTabs(filter),
		attachTarget: async (targetId, attachOptions) => {
			const result = await controlSession.attachTabWatcher(parseControlTabTarget(targetId, 'attach'), attachOptions)
			if (!result.ok) {
				throw new Error(result.error)
			}
			return { ok: true, tab: result.tab, watcherId: result.watcherId }
		},
		detachTarget: async (targetId) => {
			const result = await controlSession.detachTabWatcher(parseControlTabTarget(targetId, 'detach'))
			if (!result.ok) {
				throw new Error(result.error)
			}
			return { ok: true, tab: result.tab, watcherId: result.watcherId }
		},
		getExtensionDiagnostics: async () => {
			const diagnostics = await controlSession.getDiagnostics()
			return {
				ok: true,
				extension: {
					id: diagnostics.extensionId,
					version: diagnostics.extensionVersion,
				},
				control: diagnostics.control,
				tabWatchers: diagnostics.tabWatchers,
				recentEvents: diagnostics.recentEvents,
			}
		},
	}

	function sendHostInfo(): void {
		messaging.send({
			type: 'host_info',
			watcherId: hostInfo.watcherId,
			watcherHost: hostInfo.watcherHost,
			watcherPort: hostInfo.watcherPort,
			pid: hostInfo.watcherPid,
		})
	}
}

const createDetachedSession = (message: string): CdpSessionHandle => ({
	isAttached: () => false,
	sendAndWait: async () => {
		const error = new Error(message)
		;(error as Error & { code?: string }).code = 'cdp_not_attached'
		throw error
	},
	onEvent: () => () => {},
})

/** Control watchers operate on whole tabs; iframe target ids are rejected with actionable errors. */
const parseControlTabTarget = (targetId: string, action: 'attach' | 'detach'): number => {
	const target = parseExtensionTargetId(targetId)
	if (!target.frameId) {
		return target.tabId
	}
	if (action === 'attach') {
		throw new Error(`Cannot attach iframe ${target.frameId} from extension-control before tab ${target.tabId} has a tab watcher`)
	}
	throw new Error(`Cannot detach iframe ${target.frameId} from extension-control. Detach tab ${target.tabId} instead.`)
}
