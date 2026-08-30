import type { PopupTabAction } from '../background/popup-protocol.js'

/** Per-tab buttons that show transient feedback. */
export type TabButtonAction = Extract<PopupTabAction, 'attach' | 'detach'> | 'copy-info'

type Feedback = {
	label: string
	/** Replacement icon markup, when the button is icon-only. */
	icon?: string
	/** Epoch ms after which the feedback stops being painted. */
	expiresAt: number
}

/**
 * Transient per-tab button state, as data rather than as DOM mutations.
 *
 * The popup re-renders its tab list by wholesale `innerHTML` replacement every 2s, while
 * a parallel system used to mutate individual buttons ("Attaching…", "Copied!") and hold
 * restore closures over those nodes. Any forced re-render — which every action triggers —
 * replaced the nodes, so the closures and their `setTimeout(restore, 1500)` operated on
 * detached DOM.
 *
 * Keeping the state here means the single render pass paints it and no node is ever
 * mutated behind the renderer's back.
 */
const feedback = new Map<string, Feedback>()

const key = (tabId: number, action: TabButtonAction): string => `${tabId}:${action}`

/** Show feedback on a button until `durationMs` elapses. Pass `Infinity` for "until cleared". */
export const setTabFeedback = (tabId: number, action: TabButtonAction, label: string, durationMs: number, icon?: string): void => {
	feedback.set(key(tabId, action), { label, icon, expiresAt: durationMs === Infinity ? Infinity : Date.now() + durationMs })
}

/** Stop showing feedback on a button. */
export const clearTabFeedback = (tabId: number, action: TabButtonAction): void => {
	feedback.delete(key(tabId, action))
}

/** Read live feedback for a button, dropping it once expired. */
export const getTabFeedback = (tabId: number, action: TabButtonAction): Feedback | null => {
	const entry = feedback.get(key(tabId, action))
	if (!entry) {
		return null
	}
	if (entry.expiresAt <= Date.now()) {
		feedback.delete(key(tabId, action))
		return null
	}
	return entry
}

/** True when any feedback is still live, so the caller knows a re-render is pending. */
export const hasPendingTabFeedback = (): boolean => {
	for (const [entryKey, entry] of feedback.entries()) {
		if (entry.expiresAt <= Date.now()) {
			feedback.delete(entryKey)
			continue
		}
		return true
	}
	return false
}
