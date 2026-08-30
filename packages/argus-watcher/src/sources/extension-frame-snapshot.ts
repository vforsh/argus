import type { ExtensionFrameSnapshot, ExtensionSession } from '../native-messaging/session-manager.js'
import type { ExtensionFrameState } from './extension-frame-state.js'

export type ApplyFrameSnapshotDeps = {
	/** Removes a frame and its subtree from state, preserving the requested-frame hint. */
	removeFrame: (tabId: number, frameId: string) => void
	/** Resolve an iframe's document title from its execution context (async, best effort). */
	refreshFrameTitle: (session: ExtensionSession, frameId: string) => Promise<void>
	/** Re-resolve the requested target against the new table; returns true when selection changed. */
	reconcileTargetSelection: (session: ExtensionSession) => boolean
	/** Refresh status/indicator when the active target's metadata changed without a selection change. */
	emitTargetChanged: (session: ExtensionSession) => void
}

/**
 * Apply the extension's authoritative frame table to the watcher's frame state.
 *
 * This is the ONLY code path that reconciles state from a snapshot (pushed or pulled), and
 * it is deliberately idempotent: `frames` is always the full table, so applying the same
 * snapshot twice is a no-op. Three invariants define the contract:
 *
 * - `events.onPageNavigation` is NEVER fired here. Log rotation, sourcemap cache resets,
 *   and the page indicator react only to the real top-frame `Page.frameNavigated` event
 *   (see extension-session-events.ts); before C2 the extension replayed fabricated copies
 *   of that event on every 150ms resync and each one re-triggered those side effects.
 * - Title lookups are limited to frames that are new, whose URL changed, or that still
 *   have no title — not every frame on every snapshot, which is what made the pre-C2
 *   resync storm O(frames) in CDP round-trips.
 * - Selection reconciliation runs exactly once per snapshot, after the table is updated,
 *   so a removed-then-recreated iframe re-resolves through the requested-frame hint.
 */
export const applyExtensionFrameSnapshot = (
	session: ExtensionSession,
	state: ExtensionFrameState,
	snapshot: ExtensionFrameSnapshot,
	deps: ApplyFrameSnapshotDeps,
): void => {
	const nextIds = new Set(snapshot.frames.map((frame) => frame.frameId))
	for (const frameId of [...state.frames.keys()]) {
		if (!nextIds.has(frameId)) {
			// removeFrame drops subtrees recursively; a child listed in the snapshot is
			// re-added below, so over-removal cannot lose live frames.
			deps.removeFrame(session.tabId, frameId)
		}
	}

	let activeTargetTouched = false
	for (const frame of snapshot.frames) {
		const existing = state.frames.get(frame.frameId)
		const urlChanged = existing != null && frame.url !== '' && existing.url !== frame.url

		if (!existing) {
			state.frames.set(frame.frameId, {
				frameId: frame.frameId,
				parentFrameId: frame.parentFrameId,
				url: frame.url,
				title: frame.title,
				sessionId: frame.sessionId,
			})
		} else {
			existing.parentFrameId = frame.parentFrameId
			if (frame.url !== '') {
				existing.url = frame.url
			}
			// The snapshot's title is the frame *name* attribute; a locally resolved
			// document.title is strictly better, so never downgrade one to null.
			if (existing.title == null && frame.title != null) {
				existing.title = frame.title
			}
			existing.sessionId = frame.sessionId ?? existing.sessionId
		}

		if (frame.frameId === state.requestedFrameId || frame.frameId === state.activeFrameId) {
			activeTargetTouched = activeTargetTouched || !existing || urlChanged
		}

		const record = state.frames.get(frame.frameId)!
		const needsTitle = (!existing || urlChanged || record.title == null) && frame.frameId !== snapshot.topFrameId
		if (needsTitle && state.executionContexts.has(frame.frameId)) {
			void deps.refreshFrameTitle(session, frame.frameId)
		}
	}

	if (snapshot.topFrameId != null) {
		state.topFrameId = snapshot.topFrameId
		const topFrame = state.frames.get(snapshot.topFrameId)
		if (topFrame?.url) {
			session.url = topFrame.url
		}
	}

	const selectionChanged = deps.reconcileTargetSelection(session)
	if (!selectionChanged && activeTargetTouched) {
		deps.emitTargetChanged(session)
	}
}
