import type { ExtensionSession } from '../native-messaging/session-manager.js'
import type { CdpSourceTarget } from './types.js'
import {
	buildPageTarget,
	collectFrameTree,
	createRequestedFrameHint,
	frameToTarget,
	resolveRequestedTarget,
	type CdpFrameTreeNode,
	type ExtensionFrameState,
} from './extension-frame-state.js'

export const seedExtensionFrameState = (session: ExtensionSession, state: ExtensionFrameState): ExtensionFrameState => {
	if (state.frames.size > 0 || session.frames.length === 0) {
		return state
	}

	state.topFrameId = session.topFrameId
	for (const frame of session.frames) {
		state.frames.set(frame.frameId, {
			frameId: frame.frameId,
			parentFrameId: frame.parentFrameId,
			url: frame.url,
			title: frame.title,
			sessionId: frame.sessionId,
		})
	}

	return state
}

export const getSelectedExtensionTarget = (session: ExtensionSession, state: ExtensionFrameState | undefined): CdpSourceTarget => {
	if (!state?.activeFrameId) {
		return buildPageTarget(session, { attached: true })
	}

	const frame = state.frames.get(state.activeFrameId)
	if (!frame) {
		return buildPageTarget(session, { attached: true })
	}

	return frameToTarget(session.tabId, frame, { attached: true, faviconUrl: session.faviconUrl, topFrameId: state.topFrameId })
}

export const setRequestedTargetSelection = (state: ExtensionFrameState, frameId: string | null): void => {
	const frame = frameId ? state.frames.get(frameId) : null
	state.requestedFrameId = frameId
	state.requestedFrameHint = createRequestedFrameHint(frame)
	state.requestedFrameDetached = false
}

export const reconcileExtensionTargetSelection = (session: ExtensionSession, state: ExtensionFrameState, onTargetChanged: () => void): boolean => {
	const resolution = resolveRequestedTarget(state)

	if (resolution.kind === 'page') {
		state.requestedFrameDetached = false
		return activatePageTarget(state, onTargetChanged)
	}

	if (resolution.kind === 'pending') {
		return false
	}

	state.requestedFrameDetached = false
	if (state.activeFrameId === resolution.frameId) {
		return false
	}

	return activateFrameTarget(state, resolution.frameId, onTargetChanged)
}

export const refreshExtensionFrameTree = async (
	session: ExtensionSession,
	state: ExtensionFrameState,
	refreshFrameTitle: (frameId: string) => Promise<void>,
): Promise<void> => {
	const frameTree = (await session.handle.sendAndWait('Page.getFrameTree')) as { frameTree?: CdpFrameTreeNode }
	collectFrameTree(frameTree.frameTree, state)
	await Promise.all([...state.executionContexts.keys()].map((frameId) => refreshFrameTitle(frameId)))
}

export const removeExtensionFrame = (state: ExtensionFrameState, frameId: string): void => {
	const childIds = [...state.frames.values()].filter((frame) => frame.parentFrameId === frameId).map((frame) => frame.frameId)
	for (const childId of childIds) {
		removeExtensionFrame(state, childId)
	}

	/**
	 * Keep the user's requested iframe selection across reload/navigation detaches.
	 * Frame ids are ephemeral, so the stored frame hint lets selection survive a fresh id after reload.
	 */
	if (state.activeFrameId === frameId) {
		state.requestedFrameDetached = state.requestedFrameId === frameId
		state.activeFrameId = null
		state.activeAttachedAt = null
	}

	state.frames.delete(frameId)
	state.executionContexts.delete(frameId)
	state.pendingTitleLoads.delete(frameId)
}

export const refreshExtensionFrameTitle = async (
	session: ExtensionSession,
	state: ExtensionFrameState,
	frameId: string,
	onActiveFrameUpdated: () => void,
	contextId?: number,
): Promise<void> => {
	if (frameId === state.topFrameId || state.pendingTitleLoads.has(frameId)) {
		return
	}

	const executionContextId = contextId ?? state.executionContexts.get(frameId)
	if (executionContextId == null) {
		return
	}

	const frame = state.frames.get(frameId)
	if (!frame) {
		return
	}

	state.pendingTitleLoads.add(frameId)
	try {
		const evaluated = (await session.handle.sendAndWait(
			'Runtime.evaluate',
			{
				expression: 'document.title',
				contextId: executionContextId,
				returnByValue: true,
				silent: true,
			},
			frame.sessionId ? { sessionId: frame.sessionId } : undefined,
		)) as { result?: { value?: unknown } }

		const title = typeof evaluated.result?.value === 'string' ? evaluated.result.value.trim() : ''
		const latestFrame = state.frames.get(frameId)
		if (!latestFrame) {
			return
		}

		latestFrame.title = title || null
		if (state.activeFrameId === frameId) {
			onActiveFrameUpdated()
		}
	} catch {
		// Ignore transient frame-title lookup failures during navigation/bootstrap.
	} finally {
		state.pendingTitleLoads.delete(frameId)
	}
}

const activatePageTarget = (state: ExtensionFrameState, onTargetChanged: () => void): boolean => {
	if (state.activeFrameId == null) {
		if (state.activeAttachedAt == null) {
			state.activeAttachedAt = Date.now()
			onTargetChanged()
			return true
		}
		return false
	}

	state.activeFrameId = null
	state.activeAttachedAt = Date.now()
	onTargetChanged()
	return true
}

const activateFrameTarget = (state: ExtensionFrameState, frameId: string, onTargetChanged: () => void): boolean => {
	state.activeFrameId = frameId
	state.activeAttachedAt = Date.now()
	onTargetChanged()
	return true
}
