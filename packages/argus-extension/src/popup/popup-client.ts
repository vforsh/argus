import type { PopupAction, PopupActionMessage, PopupResponseFor } from '../background/popup-protocol.js'

/**
 * Send one action to the service worker and get back that action's response type.
 *
 * The response type is looked up from the action rather than supplied by the caller, so
 * a call site cannot claim the wrong shape — the mistake the old
 * `sendMessage<T>(message)` signature allowed silently.
 */
export const sendPopupMessage = async <M extends PopupActionMessage>(message: M): Promise<PopupResponseFor<M['action']>> => {
	return new Promise((resolve) => {
		chrome.runtime.sendMessage(message, resolve)
	})
}

/**
 * Send an action and throw if it failed.
 *
 * @throws {Error} With the service worker's error message when `success` is false.
 */
export const runPopupMessage = async <M extends PopupActionMessage>(
	message: M,
): Promise<Extract<PopupResponseFor<M['action']>, { success: true }>> => {
	const response = await sendPopupMessage(message)
	if (!response.success) {
		throw new Error(response.error)
	}

	return response as Extract<PopupResponseFor<M['action']>, { success: true }>
}

export type { PopupAction }
