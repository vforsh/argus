/**
 * Build per-tab watcher status payloads for the popup from a live bridge session.
 */

import type { DebuggerManager } from './debugger-manager.js'
import type { TabBridgeSession } from './tab-bridge-session.js'
import type { PopupWatcherStatus } from './popup-protocol.js'
import { parseWatcherTargetId } from './popup-targets.js'

export function buildWatcherStatus(debuggerManager: DebuggerManager, tabId: number, session: TabBridgeSession): PopupWatcherStatus | null {
	const watcherInfo = session.getWatcherInfo()
	const targetInfo = session.getTargetInfo()
	const parsedTarget = targetInfo ? parseWatcherTargetId(targetInfo.targetId) : null

	if (!watcherInfo && !targetInfo) {
		return createWatcherStatus(debuggerManager, tabId, session, null, null)
	}

	return createWatcherStatus(
		debuggerManager,
		tabId,
		session,
		watcherInfo ?? null,
		targetInfo && parsedTarget
			? {
					type: parsedTarget.frameId ? 'iframe' : 'page',
					title: targetInfo.title,
					url: targetInfo.url,
					targetId: targetInfo.targetId,
					frameId: parsedTarget.frameId,
					attachedAt: targetInfo.attachedAt,
					targetReady: targetInfo.targetReady,
				}
			: null,
	)
}

function createWatcherStatus(
	debuggerManager: DebuggerManager,
	tabId: number,
	session: TabBridgeSession,
	watcherInfo: ReturnType<TabBridgeSession['getWatcherInfo']>,
	currentTarget: PopupWatcherStatus['currentTarget'],
): PopupWatcherStatus {
	const readiness = buildWatcherReadiness(debuggerManager, tabId, session, watcherInfo, currentTarget)
	return {
		tabId,
		bridgeConnected: readiness.nativeHostConnected,
		nativeHostConnected: readiness.nativeHostConnected,
		watcherReady: readiness.watcherReady,
		targetReady: readiness.targetReady,
		targetState: readiness.targetState,
		watcherId: watcherInfo?.watcherId ?? null,
		watcherHost: watcherInfo?.watcherHost ?? null,
		watcherPort: watcherInfo?.watcherPort ?? null,
		nativeHostPid: watcherInfo?.pid ?? null,
		lastMessageAt: session.getLastMessageAt(),
		currentTarget,
	}
}

function buildWatcherReadiness(
	debuggerManager: DebuggerManager,
	tabId: number,
	session: TabBridgeSession,
	watcherInfo: ReturnType<TabBridgeSession['getWatcherInfo']>,
	currentTarget: PopupWatcherStatus['currentTarget'],
): Pick<PopupWatcherStatus, 'nativeHostConnected' | 'watcherReady' | 'targetReady' | 'targetState'> {
	const nativeHostConnected = session.isConnected()
	const watcherReady = nativeHostConnected && Boolean(watcherInfo?.watcherId && watcherInfo.watcherHost && watcherInfo.watcherPort != null)
	const targetReady = currentTarget?.targetReady ?? getTargetReadiness(debuggerManager, tabId, currentTarget)

	return {
		nativeHostConnected,
		watcherReady,
		targetReady,
		targetState: targetReady == null ? 'not-selected' : targetReady ? 'ready' : 'rebinding',
	}
}

/**
 * The watcher can be connected while a remembered iframe is still rebinding after reload.
 * Treat the extension's live frame map as the source of truth for whether frame-scoped
 * commands have a concrete execution target again.
 */
function getTargetReadiness(debuggerManager: DebuggerManager, tabId: number, target: PopupWatcherStatus['currentTarget']): boolean | null {
	if (!target) {
		return null
	}

	if (!target.frameId) {
		return debuggerManager.isAttached(tabId)
	}

	const frame = debuggerManager.getFrames(tabId).find((candidate) => candidate.frameId === target.frameId)
	return Boolean(frame?.sessionId)
}
