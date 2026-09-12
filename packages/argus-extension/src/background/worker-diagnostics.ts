import type { PopupStatusPayload, PopupWatcherStatus } from './popup-protocol.js'
import type { ControlDiagnostics } from '../types/messages.js'
import type { ControlBridgeSession } from './control-bridge-session.js'
import type { TabBridgeSession } from './tab-bridge-session.js'
import type { DebuggerManager } from './debugger-manager.js'
import { lifecycleSnapshot } from './lifecycle-journal.js'

/** Build independent control, debugger and selected-target evidence without issuing page commands. */
export function buildWorkerDiagnostics(
	controlBridgeSession: ControlBridgeSession,
	sessions: Iterable<readonly [number, TabBridgeSession]>,
	debuggerManager: DebuggerManager,
	recentEvents: ControlDiagnostics['recentEvents'],
): ControlDiagnostics {
	const controlInfo = controlBridgeSession.getWatcherInfo()
	return {
		extensionId: chrome.runtime.id ?? null,
		extensionVersion: chrome.runtime.getManifest().version ?? null,
		control: {
			connected: controlBridgeSession.isConnected(),
			watcherId: controlInfo?.watcherId ?? null,
			watcherHost: controlInfo?.watcherHost ?? null,
			watcherPort: controlInfo?.watcherPort ?? null,
			pid: controlInfo?.pid ?? null,
			lastMessageAt: controlBridgeSession.getLastMessageAt(),
		},
		tabWatchers: [...sessions].map(([tabId, session]) => buildTabBridgeStatus(tabId, session, debuggerManager)),
		recentEvents,
		journal: lifecycleSnapshot(),
	}
}

function buildTabBridgeStatus(tabId: number, session: TabBridgeSession, debuggerManager: DebuggerManager): ControlDiagnostics['tabWatchers'][number] {
	const watcher = session.getWatcherInfo()
	const target = session.getTargetInfo()
	return {
		tabId,
		debuggerAttached: debuggerManager.isAttached(tabId),
		connected: session.isConnected(),
		watcherId: watcher?.watcherId ?? null,
		watcherHost: watcher?.watcherHost ?? null,
		watcherPort: watcher?.watcherPort ?? null,
		pid: watcher?.pid ?? null,
		targetId: target?.targetId ?? null,
		targetTitle: target?.title ?? null,
		targetUrl: target?.url ?? null,
		targetReady: target?.targetReady ?? null,
		lastMessageAt: session.getLastMessageAt(),
	}
}

/** Build the popup's tab bridge view; a control connection does not imply any attached tab. */
export function buildWorkerPopupStatus(
	debuggerManager: DebuggerManager,
	watchers: PopupWatcherStatus[],
	sessions: TabBridgeSession[],
): PopupStatusPayload {
	return {
		bridgeConnected: sessions.some((session) => session.isConnected()),
		attachedTabs: debuggerManager.listAttached().map((target) => ({ tabId: target.tabId, url: target.url, title: target.title })),
		watchers,
	}
}
