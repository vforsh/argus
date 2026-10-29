import type { ExtensionIframeMatch } from '@vforsh/argus-core'
import type { ExtensionSession } from '../native-messaging/session-manager.js'
import type { CdpSourceTarget } from './types.js'
import {
	buildFrameTargets,
	buildPageTarget,
	createRequestedFrameHint,
	formatFrameTargetId,
	formatPageTargetId,
	frameToTarget,
	isSelectedTargetReady,
	resolveRequestedTarget,
	type ExtensionFrameState,
	type RequestedFrameHint,
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
	const frameId = state?.requestedFrameId ?? state?.activeFrameId
	if (!state || !frameId) {
		return buildPageTarget(session, { attached: true })
	}

	const frame = state.frames.get(frameId)
	if (frame) {
		return frameToTarget(session.tabId, frame, { attached: true, faviconUrl: session.faviconUrl, topFrameId: state.topFrameId })
	}

	return buildSelectedIframeFallbackTarget(session, state)
}

/**
 * Record the user's target selection.
 *
 * `match` is the selector an `/attach` caller picked the iframe with; `null` clears it. Left
 * `undefined` (an extension-side selection such as the popup or a remembered-target restore), a
 * re-selection of the same frame keeps the selector it already had.
 */
export const setRequestedTargetSelection = (state: ExtensionFrameState, frameId: string | null, match?: ExtensionIframeMatch | null): void => {
	const sameFrame = state.requestedFrameId === frameId
	if (!sameFrame) {
		state.activeAttachedAt = null
	}
	const previousHint = sameFrame ? state.requestedFrameHint : null
	const nextMatch = match === undefined ? previousHint?.match : (match ?? undefined)
	state.requestedFrameId = frameId
	if (!frameId) {
		state.requestedFrameHint = null
		return
	}
	// A frame that is gone keeps its previous URL/title fields; a match alone still makes a hint.
	const frameHint = createRequestedFrameHint(state.frames.get(frameId)) ?? previousHint
	state.requestedFrameHint = frameHint ? withMatch(frameHint, nextMatch) : createRequestedFrameHint(null, nextMatch)
}

const withMatch = (hint: RequestedFrameHint, match: ExtensionIframeMatch | undefined): RequestedFrameHint => {
	const { match: _previous, ...rest } = hint
	return match ? { ...rest, match } : rest
}

/** List discovered targets plus a selected, pending placeholder when the requested iframe is missing. */
export const listExtensionTargets = (session: ExtensionSession, state: ExtensionFrameState | undefined): CdpSourceTarget[] => {
	if (!state) {
		return [buildPageTarget(session, { attached: true })]
	}

	const selected = getSelectedExtensionTarget(session, state)
	selected.targetReady = isSelectedTargetReady(state)
	const targets = [buildPageTarget(session, { attached: false }), ...buildFrameTargets(state, session.tabId, null, session.faviconUrl)]
	const selectedIndex = targets.findIndex((target) => target.id === selected.id)
	if (selectedIndex < 0) {
		targets.push(selected)
	} else {
		targets[selectedIndex] = selected
	}
	return targets
}

export const reconcileExtensionTargetSelection = (session: ExtensionSession, state: ExtensionFrameState, onTargetChanged: () => void): boolean => {
	const resolution = resolveRequestedTarget(state)

	if (resolution.kind === 'page') {
		return activatePageTarget(state, onTargetChanged)
	}

	if (resolution.kind === 'pending') {
		if (state.activeFrameId == null && state.activeAttachedAt != null) {
			return false
		}
		state.activeFrameId = null
		state.activeAttachedAt = Date.now()
		onTargetChanged()
		return true
	}

	syncRequestedFrameSelection(state, resolution.frameId)
	if (state.activeFrameId === resolution.frameId) {
		return false
	}

	return activateFrameTarget(state, resolution.frameId, onTargetChanged)
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
		const evaluated = await session.handle.sendAndWait(
			'Runtime.evaluate',
			{
				expression: 'document.title',
				contextId: executionContextId,
				returnByValue: true,
				silent: true,
			},
			frame.sessionId ? { sessionId: frame.sessionId } : undefined,
		)

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

const syncRequestedFrameSelection = (state: ExtensionFrameState, frameId: string): void => {
	const frame = state.frames.get(frameId)
	if (!frame) {
		return
	}

	state.requestedFrameId = frameId
	// The frame-derived fields follow the frame; the user's selector stays what they asked for.
	state.requestedFrameHint = createRequestedFrameHint(frame, state.requestedFrameHint?.match)
}

/**
 * Extension events can briefly leave us with a selected iframe context before the matching frame
 * metadata arrives. Keep status/indicator aligned with the selected iframe hint instead of
 * regressing to the top page during that gap.
 */
const buildSelectedIframeFallbackTarget = (session: ExtensionSession, state: ExtensionFrameState): CdpSourceTarget => {
	const hint = state.requestedFrameHint
	const frameId = state.requestedFrameId ?? state.activeFrameId
	if (!frameId) {
		return buildPageTarget(session, { attached: true })
	}

	return {
		id: formatFrameTargetId(session.tabId, frameId),
		title: hint?.title ?? hint?.url ?? `iframe ${frameId}`,
		url: hint?.url ?? session.url,
		type: 'iframe',
		parentId: formatPageTargetId(session.tabId),
		faviconUrl: session.faviconUrl,
		attached: true,
		targetReady: false,
	}
}
