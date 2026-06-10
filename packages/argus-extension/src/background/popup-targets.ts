/**
 * Read-only views of the debugger frame tree, shaped for the popup UI.
 */

import type { DebuggerManager } from './debugger-manager.js'
import type { SelectionTarget } from './target-selection-history.js'
import type { PopupTarget } from './popup-protocol.js'

/** Parse watcher target ids (`tab:<id>` / `frame:<tabId>:<frameId>`). Returns null for unknown formats. */
export function parseWatcherTargetId(targetId: string): { tabId: number; frameId: string | null } | null {
	if (targetId.startsWith('tab:')) {
		const tabId = Number.parseInt(targetId.slice(4), 10)
		return Number.isFinite(tabId) ? { tabId, frameId: null } : null
	}

	if (targetId.startsWith('frame:')) {
		const [, tabIdRaw, ...frameIdParts] = targetId.split(':')
		const tabId = Number.parseInt(tabIdRaw ?? '', 10)
		const frameId = frameIdParts.join(':')
		return Number.isFinite(tabId) && frameId ? { tabId, frameId } : null
	}

	return null
}

/** List the page plus iframe targets for an attached tab, in popup display shape. */
export function getPopupTargets(debuggerManager: DebuggerManager, tabId: number): PopupTarget[] {
	const frames = debuggerManager.getFrames(tabId)
	const topFrameId = debuggerManager.getTarget(tabId)?.topFrameId ?? null
	const topFrame = frames.find((frame) => frame.frameId === topFrameId) ?? frames.find((frame) => frame.parentFrameId == null)
	if (!topFrame) {
		return []
	}

	return [
		{
			type: 'page',
			frameId: null,
			parentFrameId: null,
			title: topFrame.title || 'Page',
			url: topFrame.url,
		},
		...frames
			.filter((frame) => frame.frameId !== topFrame.frameId)
			.map((frame) => ({
				type: 'iframe' as const,
				frameId: frame.frameId,
				parentFrameId: frame.parentFrameId === topFrame.frameId ? null : frame.parentFrameId,
				title: frame.title || frame.url || `iframe ${frame.frameId.slice(0, 8)}`,
				url: frame.url,
			})),
	]
}

export function getPopupTarget(debuggerManager: DebuggerManager, tabId: number, frameId: string | null): PopupTarget | null {
	return getPopupTargets(debuggerManager, tabId).find((target) => (target.frameId ?? null) === frameId) ?? null
}

export function getRequiredIframeTarget(debuggerManager: DebuggerManager, tabId: number, frameId: string | null): PopupTarget {
	const target = getPopupTarget(debuggerManager, tabId, frameId)
	if (!target || target.type !== 'iframe' || !target.frameId) {
		throw new Error(`Unknown iframe target for tab ${tabId}`)
	}

	return target
}

export function getPageUrlForTab(debuggerManager: DebuggerManager, tabId: number): string | null {
	return getPopupTarget(debuggerManager, tabId, null)?.url ?? debuggerManager.getTarget(tabId)?.url ?? null
}

/** Project a popup target to the shape persisted by selection/visibility history stores. */
export function toSelectionTarget(target: PopupTarget): SelectionTarget {
	return {
		type: target.type,
		frameId: target.frameId,
		title: target.title,
		url: target.url,
	}
}
