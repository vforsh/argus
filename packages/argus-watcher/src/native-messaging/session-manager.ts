/**
 * Session manager for CDP sessions routed through the Chrome extension.
 * Implements CdpSessionHandle interface using Native Messaging.
 */

import { createNotAttachedError } from '../errors.js'
import type { CdpEvent, CdpEventPayload } from '../cdp/protocol.js'
import type { NativeMessagingHandler } from './messaging.js'
import type {
	PendingRequest,
	CdpEventHandler,
	CdpEventMeta,
	FrameSnapshot,
	TabAttachedMessage,
	NativeCookie,
	ExtensionToTabHost,
	TabHostToExtension,
} from './types.js'
import type { CdpSessionHandle } from '../cdp/connection.js'

export type ExtensionSession = {
	tabId: number
	url: string
	title: string
	faviconUrl?: string
	attachedAt: number
	topFrameId: string | null
	frames: FrameSnapshot[]
	handle: CdpSessionHandle
}

export type SessionManagerEvents = {
	onAttach: (session: ExtensionSession) => void
	onDetach: (tabId: number, reason: string) => void
	onTargetSelected: (tabId: number, frameId: string | null) => void
}

let nextRequestId = 1

/**
 * Manages CDP sessions with tabs attached via the Chrome extension.
 */
export class SessionManager {
	private messaging: NativeMessagingHandler<ExtensionToTabHost, TabHostToExtension>
	private sessions = new Map<number, ExtensionSession>()
	private pendingRequests = new Map<number, PendingRequest>()
	private eventHandlers = new Map<number, Map<string, Set<CdpEventHandler<never>>>>()
	private events: SessionManagerEvents

	constructor(messaging: NativeMessagingHandler<ExtensionToTabHost, TabHostToExtension>, events: SessionManagerEvents) {
		this.messaging = messaging
		this.events = events
		this.setupMessageHandling()
	}

	/**
	 * Set up message handling from the extension.
	 */
	private setupMessageHandling(): void {
		this.messaging.onMessage((message: ExtensionToTabHost) => {
			this.handleMessage(message)
		})
	}

	/**
	 * Handle a message from the extension.
	 */
	private handleMessage(message: ExtensionToTabHost): void {
		switch (message.type) {
			case 'tab_attached':
				this.handleTabAttached(message)
				break

			case 'tab_detached':
				this.handleTabDetached(message)
				break

			case 'cdp_event':
				this.handleCdpEvent(message)
				break

			case 'cdp_response':
				this.handleCdpResponse(message)
				break

			case 'cookie_query_response':
				this.handleCookieQueryResponse(message)
				break

			case 'target_selected':
				this.events.onTargetSelected(message.tabId, message.frameId ?? null)
				break
		}
	}

	/**
	 * Handle tab attachment notification.
	 */
	private handleTabAttached(message: TabAttachedMessage): void {
		const session = this.createSession(message)
		this.events.onAttach(session)
	}

	/**
	 * Handle tab detachment notification.
	 */
	private handleTabDetached(message: ExtensionToTabHost & { type: 'tab_detached' }): void {
		const session = this.sessions.get(message.tabId)
		if (session) {
			this.sessions.delete(message.tabId)
			this.eventHandlers.delete(message.tabId)
		}
		this.events.onDetach(message.tabId, message.reason)
	}

	/**
	 * Handle CDP event from the extension.
	 */
	private handleCdpEvent(message: ExtensionToTabHost & { type: 'cdp_event' }): void {
		const tabHandlers = this.eventHandlers.get(message.tabId)
		if (!tabHandlers) {
			return
		}

		const methodHandlers = tabHandlers.get(message.method)
		if (!methodHandlers || methodHandlers.size === 0) {
			return
		}

		const meta: CdpEventMeta = { sessionId: message.sessionId ?? null }
		for (const handler of methodHandlers) {
			try {
				// The wire carries an arbitrary method string; each handler's payload type was
				// checked when it was registered against a specific event.
				;(handler as CdpEventHandler<CdpEvent>)(message.params as CdpEventPayload<CdpEvent>, meta)
			} catch {
				// Ignore handler errors
			}
		}
	}

	/**
	 * Handle CDP response from the extension.
	 */
	private handleCdpResponse(message: ExtensionToTabHost & { type: 'cdp_response' }): void {
		this.resolvePendingRequest(message.requestId, message.result, message.error)
	}

	/**
	 * Handle cookie query response from the extension.
	 */
	private handleCookieQueryResponse(message: ExtensionToTabHost & { type: 'cookie_query_response' }): void {
		this.resolvePendingRequest(message.requestId, message.cookies ?? [], message.error)
	}

	private resolvePendingRequest(requestId: number, result: unknown, error?: { message: string }): void {
		const pending = this.pendingRequests.get(requestId)
		if (!pending) {
			return
		}

		this.pendingRequests.delete(requestId)
		clearTimeout(pending.timeout)

		if (error) {
			pending.reject(new Error(error.message))
		} else {
			pending.resolve(result)
		}
	}

	/**
	 * Create a session for an attached tab.
	 */
	private createSession(message: TabAttachedMessage): ExtensionSession {
		const { tabId, url, title, faviconUrl } = message
		const tabHandlers = new Map<string, Set<CdpEventHandler<never>>>()
		this.eventHandlers.set(tabId, tabHandlers)

		const handle: CdpSessionHandle = {
			isAttached: () => this.sessions.has(tabId),

			sendAndWait: async (method, params, options) => {
				if (!this.sessions.has(tabId)) {
					throw createNotAttachedError()
				}

				return this.sendBridgeRequest(
					(requestId) =>
						({
							type: 'cdp_command',
							requestId,
							tabId,
							method,
							params,
							sessionId: options?.sessionId,
						}) satisfies TabHostToExtension,
					options?.timeoutMs ?? 30000,
				)
			},

			onEvent: (method, handler) => {
				let methodHandlers = tabHandlers.get(method)
				if (!methodHandlers) {
					methodHandlers = new Set()
					tabHandlers.set(method, methodHandlers)
				}
				// The registry spans every event, so payload types are erased in storage;
				// the method/handler pairing was checked at this call.
				methodHandlers.add(handler as CdpEventHandler<never>)

				return () => {
					methodHandlers?.delete(handler as CdpEventHandler<never>)
				}
			},
		}

		const session: ExtensionSession = {
			tabId,
			url,
			title,
			faviconUrl,
			attachedAt: Date.now(),
			topFrameId: message.topFrameId ?? null,
			frames: message.frames ?? [],
			handle,
		}

		this.sessions.set(tabId, session)
		return session
	}

	/**
	 * Query browser cookies for the attached tab's cookie store.
	 */
	async getCookies(tabId: number, query?: { domain?: string; url?: string }, timeoutMs = 5000): Promise<NativeCookie[]> {
		if (!this.sessions.has(tabId)) {
			throw createNotAttachedError()
		}

		return await this.sendBridgeRequest(
			(requestId) =>
				({
					type: 'cookie_query',
					requestId,
					tabId,
					domain: query?.domain,
					url: query?.url,
				}) satisfies TabHostToExtension,
			timeoutMs,
		)
	}

	/**
	 * Request to detach from a tab.
	 */
	detachTab(tabId: number): void {
		const message: TabHostToExtension = {
			type: 'detach_tab',
			tabId,
		}
		this.messaging.send(message)
	}

	private sendBridgeRequest<T>(buildMessage: (requestId: number) => TabHostToExtension, timeoutMs: number): Promise<T> {
		const requestId = nextRequestId++

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingRequests.delete(requestId)
				reject(new Error(`Bridge request timed out after ${timeoutMs}ms`))
			}, timeoutMs)

			this.pendingRequests.set(requestId, {
				requestId,
				resolve: (result) => resolve(result as T),
				reject,
				timeout,
			})
			this.messaging.send(buildMessage(requestId))
		})
	}
}
