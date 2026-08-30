/**
 * Message protocol between the popup UI and the background service worker.
 *
 * Both sides import this module, so the contract exists exactly once. Actions are a
 * discriminated union rather than a bare `action: string`, which makes "this action
 * requires a tabId" and "this action never arrives" compile-time facts instead of
 * runtime throws.
 */

import type { TabInfo } from '../types/messages.js'

export type PopupEvent = {
	ts: number
	level: 'info' | 'error'
	source: 'bridge' | 'debugger' | 'popup'
	message: string
}

export type PopupTarget = {
	type: 'page' | 'iframe'
	frameId: string | null
	parentFrameId: string | null
	title: string
	url: string
}

export type PopupWatcherStatus = {
	tabId: number
	/**
	 * Whether the tab's native-messaging bridge is connected.
	 *
	 * The bridge and the native host come up together, so this doubles as the native
	 * host's connection state; there is no separate signal to report.
	 */
	bridgeConnected: boolean
	watcherReady: boolean
	targetState: 'ready' | 'rebinding' | 'not-selected'
	watcherId: string | null
	watcherHost: string | null
	watcherPort: number | null
	nativeHostPid: number | null
	lastMessageAt: number | null
	currentTarget: PopupCurrentTarget | null
}

export type PopupCurrentTarget = {
	type: 'page' | 'iframe'
	title: string | null
	url: string | null
	targetId: string
	frameId: string | null
	attachedAt: number
	targetReady: boolean | null
}

export type PopupStatusPayload = {
	bridgeConnected: boolean
	attachedTabs: Array<{
		tabId: number
		url: string
		title: string
	}>
	watchers: PopupWatcherStatus[]
}

export type PopupTabWithTargets = TabInfo & {
	targets: PopupTarget[]
	hiddenTargets: PopupTarget[]
	selectedFrameId?: string | null
	watcher: PopupWatcherStatus | null
}

/** Actions that operate on a specific tab and therefore always carry a `tabId`. */
export type PopupTabAction = 'attach' | 'detach' | 'focusTab'

/** Actions that address one target within a tab. */
export type PopupTargetAction = 'selectTarget' | 'hideTarget' | 'showTarget'

/** Actions that read global state and take no arguments. */
export type PopupQueryAction = 'getStatus' | 'getTargets'

/**
 * A message from the popup to the service worker.
 *
 * The union carries each action's required arguments, so the service worker never has to
 * assert a `tabId` is present and never needs an unknown-action branch.
 */
export type PopupActionMessage =
	| { action: PopupTabAction; tabId: number }
	| { action: PopupTargetAction; tabId: number; frameId: string | null }
	| { action: PopupQueryAction }

/** Every action name, for narrowing an untrusted inbound message. */
export type PopupAction = PopupActionMessage['action']

/** Failure shape shared by every action. */
export type PopupFailure = { success: false; error: string }

/** Marker for actions whose success response carries no payload beyond `success`. */
export type PopupNoPayload = Record<never, never>

/**
 * Maps each action to the payload its response carries on success.
 *
 * `sendPopupMessage` reads this map, so a call site cannot claim the wrong response type
 * for an action — the mistake `sendMessage<T>` used to allow silently.
 */
export type PopupResponseMap = {
	attach: PopupNoPayload
	detach: PopupNoPayload
	focusTab: PopupNoPayload
	selectTarget: PopupNoPayload
	hideTarget: PopupNoPayload
	showTarget: PopupNoPayload
	getStatus: { status: PopupStatusPayload }
	getTargets: { tabs: PopupTabWithTargets[] }
}

/** Successful response for one action. */
export type PopupSuccess<A extends PopupAction> = { success: true } & PopupResponseMap[A]

/** Response for one action, success or failure. */
export type PopupResponseFor<A extends PopupAction> = PopupSuccess<A> | PopupFailure

/** Any popup response, as seen by the service worker's generic reply path. */
export type PopupResponse = { [A in PopupAction]: PopupResponseFor<A> }[PopupAction]
