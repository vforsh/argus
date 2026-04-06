import type { ExtensionSession } from '../native-messaging/session-manager.js'
import type { CdpSourceEvents } from './types.js'
import { parseExecutionContext, parseFrame, type ExtensionFrameState } from './extension-frame-state.js'
import { toConsoleEvent, toExceptionEvent } from './extension-log-events.js'

type RegisterExtensionSessionEventsOptions = {
	session: ExtensionSession
	events: CdpSourceEvents
	ignoreMatcher?: ((url: string) => boolean) | null
	stripUrlPrefixes?: string[]
	getOrCreateFrameState: (tabId: number) => ExtensionFrameState
	reconcileTargetSelection: (session: ExtensionSession) => boolean
	removeFrame: (tabId: number, frameId: string) => void
	refreshFrameTitle: (session: ExtensionSession, frameId: string, contextId?: number) => Promise<void>
	emitTargetChanged: (session: ExtensionSession) => void
	setCurrentSession: (session: ExtensionSession) => void
}

/**
 * Subscribe to extension-backed CDP events and funnel them back through the shared frame-state helpers.
 */
export const registerExtensionSessionEventHandlers = ({
	session,
	events,
	ignoreMatcher,
	stripUrlPrefixes,
	getOrCreateFrameState,
	reconcileTargetSelection,
	removeFrame,
	refreshFrameTitle,
	emitTargetChanged,
	setCurrentSession,
}: RegisterExtensionSessionEventsOptions): void => {
	session.handle.onEvent('Runtime.executionContextCreated', (params, meta) => {
		const context = parseExecutionContext(params)
		if (!context?.isDefault || !context.frameId) {
			return
		}
		const state = getOrCreateFrameState(session.tabId)
		state.executionContexts.set(context.frameId, context.id)
		const frame = state.frames.get(context.frameId)
		if (frame) {
			frame.sessionId = meta.sessionId ?? null
		}
		void refreshFrameTitle(session, context.frameId, context.id)
		reconcileTargetSelection(session)
	})

	session.handle.onEvent('Runtime.executionContextsCleared', () => {
		const state = getOrCreateFrameState(session.tabId)
		state.executionContexts.clear()
		state.pendingTitleLoads.clear()
	})

	session.handle.onEvent('Runtime.executionContextDestroyed', (params) => {
		const record = params as { executionContextId?: number }
		if (record.executionContextId == null) {
			return
		}

		const state = getOrCreateFrameState(session.tabId)
		for (const [frameId, contextId] of state.executionContexts.entries()) {
			if (contextId === record.executionContextId) {
				state.executionContexts.delete(frameId)
				state.pendingTitleLoads.delete(frameId)
			}
		}
	})

	session.handle.onEvent('Page.frameNavigated', (params, meta) => {
		const frame = parseFrame(params)
		if (!frame) {
			return
		}

		const state = getOrCreateFrameState(session.tabId)
		const preservedSessionId = pickFrameSessionId(meta.sessionId, state.frames.get(frame.frameId)?.sessionId)
		state.frames.set(frame.frameId, frame)
		frame.sessionId = preservedSessionId
		if (!frame.parentFrameId) {
			if (!meta.sessionId) {
				state.topFrameId = frame.frameId
				session.url = frame.url
			} else if (state.topFrameId == null) {
				state.topFrameId = frame.parentFrameId
			}
		} else if (state.executionContexts.has(frame.frameId)) {
			void refreshFrameTitle(session, frame.frameId)
		}
		setCurrentSession(session)

		if (!frame.parentFrameId && !meta.sessionId) {
			events.onPageNavigation?.({ url: frame.url, title: session.title ?? null })
		}

		if (reconcileTargetSelection(session)) {
			return
		}

		if ((!frame.parentFrameId && state.activeFrameId == null) || state.activeFrameId === frame.frameId) {
			emitTargetChanged(session)
		}
	})

	session.handle.onEvent('Page.frameAttached', (params, meta) => {
		const record = params as { frameId?: string; parentFrameId?: string }
		if (!record.frameId) {
			return
		}
		const state = getOrCreateFrameState(session.tabId)
		state.frames.set(record.frameId, {
			frameId: record.frameId,
			parentFrameId: record.parentFrameId ?? state.topFrameId ?? null,
			url: '',
			title: null,
			sessionId: pickFrameSessionId(meta.sessionId, state.frames.get(record.frameId)?.sessionId),
		})
		reconcileTargetSelection(session)
	})

	session.handle.onEvent('Page.frameDetached', (params) => {
		const record = params as { frameId?: string }
		if (!record.frameId) {
			return
		}
		removeFrame(session.tabId, record.frameId)
		reconcileTargetSelection(session)
	})

	session.handle.onEvent('Page.domContentEventFired', () => {
		events.onPageLoad?.()
	})

	session.handle.onEvent('Runtime.consoleAPICalled', (params) => {
		events.onLog(toConsoleEvent(params, session, { ignoreMatcher, stripUrlPrefixes }))
	})

	session.handle.onEvent('Runtime.exceptionThrown', (params) => {
		events.onLog(toExceptionEvent(params, session, { ignoreMatcher, stripUrlPrefixes }))
	})
}

const pickFrameSessionId = (nextSessionId: string | null | undefined, existingSessionId: string | null | undefined): string | null =>
	nextSessionId ?? existingSessionId ?? null
