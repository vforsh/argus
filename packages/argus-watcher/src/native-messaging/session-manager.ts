/**
 * Session manager for CDP sessions routed through the Chrome extension.
 * Implements CdpSessionHandle interface using Native Messaging.
 */

import type { NativeMessagingHandler } from './messaging.js'
import type {
	ExtensionToHost,
	HostToExtension,
	TabInfo,
	PendingRequest,
	CdpEventHandler,
	CdpEventMeta,
	FrameSnapshot,
	TabAttachedMessage,
	NativeCookie,
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
	enabledDomains: Set<string>
}

export type SessionManagerEvents = {
	onAttach: (session: ExtensionSession) => void
	onDetach: (tabId: number, reason: string) => void
	onTabsUpdated: (tabs: TabInfo[]) => void
	onTargetSelected: (tabId: number, frameId: string | null) => void
}

let nextRequestId = 1

/**
 * Manages CDP sessions with tabs attached via the Chrome extension.
 */
export class SessionManager {
	private messaging: NativeMessagingHandler
	private sessions = new Map<number, ExtensionSession>()
	private pendingRequests = new Map<number, PendingRequest>()
	private eventHandlers = new Map<number, Map<string, Set<CdpEventHandler>>>()
	private events: SessionManagerEvents
	private pendingTabsRequest: {
		resolve: (tabs: TabInfo[]) => void
		reject: (error: Error) => void
	} | null = null

	constructor(messaging: NativeMessagingHandler, events: SessionManagerEvents) {
		this.messaging = messaging
		this.events = events
		this.setupMessageHandling()
	}

	/**
	 * Set up message handling from the extension.
	 */
	private setupMessageHandling(): void {
		this.messaging.onMessage((message: ExtensionToHost) => {
			this.handleMessage(message)
		})
	}

	/**
	 * Handle a message from the extension.
	 */
	private handleMessage(message: ExtensionToHost): void {
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

			case 'list_tabs_response':
				this.handleListTabsResponse(message)
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
	private handleTabDetached(message: ExtensionToHost & { type: 'tab_detached' }): void {
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
	private handleCdpEvent(message: ExtensionToHost & { type: 'cdp_event' }): void {
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
				handler(message.params, meta)
			} catch {
				// Ignore handler errors
			}
		}
	}

	/**
	 * Handle CDP response from the extension.
	 */
	private handleCdpResponse(message: ExtensionToHost & { type: 'cdp_response' }): void {
		this.resolvePendingRequest(message.requestId, message.result, message.error)
	}

	/**
	 * Handle cookie query response from the extension.
	 */
	private handleCookieQueryResponse(message: ExtensionToHost & { type: 'cookie_query_response' }): void {
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
	 * Handle list tabs response from the extension.
	 */
	private handleListTabsResponse(message: ExtensionToHost & { type: 'list_tabs_response' }): void {
		if (this.pendingTabsRequest) {
			this.pendingTabsRequest.resolve(message.tabs)
			this.pendingTabsRequest = null
		}
		this.events.onTabsUpdated(message.tabs)
	}

	/**
	 * Create a session for an attached tab.
	 */
	private createSession(message: TabAttachedMessage): ExtensionSession {
		const { tabId, url, title, faviconUrl } = message
		const enabledDomains = new Set<string>()
		const tabHandlers = new Map<string, Set<CdpEventHandler>>()
		this.eventHandlers.set(tabId, tabHandlers)

		const handle: CdpSessionHandle = {
			isAttached: () => this.sessions.has(tabId),

			sendAndWait: async (method, params, options) => {
				if (!this.sessions.has(tabId)) {
					throw this.createNotAttachedError()
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
						}) satisfies HostToExtension,
					options?.timeoutMs ?? 30000,
				)
			},

			onEvent: (method, handler) => {
				let methodHandlers = tabHandlers.get(method)
				if (!methodHandlers) {
					methodHandlers = new Set()
					tabHandlers.set(method, methodHandlers)
				}
				methodHandlers.add(handler)

				return () => {
					methodHandlers?.delete(handler)
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
			enabledDomains,
		}

		this.sessions.set(tabId, session)
		return session
	}

	/**
	 * Query browser cookies for the attached tab's cookie store.
	 */
	async getCookies(tabId: number, query?: { domain?: string; url?: string }, timeoutMs = 5000): Promise<NativeCookie[]> {
		if (!this.sessions.has(tabId)) {
			throw this.createNotAttachedError()
		}

		return await this.sendBridgeRequest(
			(requestId) =>
				({
					type: 'cookie_query',
					requestId,
					tabId,
					domain: query?.domain,
					url: query?.url,
				}) satisfies HostToExtension,
			timeoutMs,
		)
	}

	/**
	 * Request to attach to a tab.
	 */
	attachTab(tabId: number): void {
		const message: HostToExtension = {
			type: 'attach_tab',
			tabId,
		}
		this.messaging.send(message)
	}

	/**
	 * Request to detach from a tab.
	 */
	detachTab(tabId: number): void {
		const message: HostToExtension = {
			type: 'detach_tab',
			tabId,
		}
		this.messaging.send(message)
	}

	/**
	 * Request to enable a CDP domain for a tab.
	 */
	enableDomain(tabId: number, domain: string): void {
		const message: HostToExtension = {
			type: 'enable_domain',
			tabId,
			domain,
		}
		this.messaging.send(message)
	}

	/**
	 * Request list of available tabs.
	 */
	async listTabs(filter?: { url?: string; title?: string }): Promise<TabInfo[]> {
		return new Promise((resolve, reject) => {
			this.pendingTabsRequest = { resolve, reject }

			const message: HostToExtension = {
				type: 'list_tabs',
				filter,
			}
			this.messaging.send(message)

			// Timeout after 5 seconds
			setTimeout(() => {
				if (this.pendingTabsRequest) {
					this.pendingTabsRequest.reject(new Error('List tabs request timed out'))
					this.pendingTabsRequest = null
				}
			}, 5000)
		})
	}

	/**
	 * Get a session by tab ID.
	 */
	getSession(tabId: number): ExtensionSession | undefined {
		return this.sessions.get(tabId)
	}

	/**
	 * Get all active sessions.
	 */
	listSessions(): ExtensionSession[] {
		return [...this.sessions.values()]
	}

	/**
	 * Check if a tab is attached.
	 */
	isAttached(tabId: number): boolean {
		return this.sessions.has(tabId)
	}

	/**
	 * Get the first attached session (for single-tab mode).
	 */
	getFirstSession(): ExtensionSession | undefined {
		for (const session of this.sessions.values()) {
			return session
		}
		return undefined
	}

	/**
	 * Create an error for when no tab is attached.
	 */
	private createNotAttachedError(): Error {
		const error = new Error('No tab attached via extension')
		;(error as Error & { code?: string }).code = 'cdp_not_attached'
		return error
	}

	private sendBridgeRequest<T>(buildMessage: (requestId: number) => HostToExtension, timeoutMs: number): Promise<T> {
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
