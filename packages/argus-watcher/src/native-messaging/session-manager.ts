/**
 * Session manager for CDP sessions routed through the Chrome extension.
 * Implements CdpSessionHandle interface using Native Messaging.
 */

import { createNotAttachedError } from '../errors.js'
import type { CdpEvent, CdpEventPayload } from '../cdp/protocol.js'
import type { NativeMessagingHandler } from './messaging.js'
import { createPendingRequestTable, createRequestIdAllocator } from './pendingRequests.js'
import type {
	CdpEventHandler,
	CdpEventMeta,
	FrameSnapshot,
	FrameSnapshotMessage,
	TabAttachedMessage,
	NativeCookie,
	ExtensionToTabHost,
	TabHostToExtension,
} from './types.js'
import type { CdpSessionHandle } from '../cdp/connection.js'

/** Authoritative frame table published by the extension for one tab. */
export type ExtensionFrameSnapshot = Pick<FrameSnapshotMessage, 'tabId' | 'topFrameId' | 'frames' | 'reason'>

export type ExtensionSession = {
	tabId: number
	url: string
	title: string
	faviconUrl?: string
	attachedAt: number
	topFrameId: string | null
	frames: FrameSnapshot[]
	handle: CdpSessionHandle
	/**
	 * Pull the extension's current frame table. With `refresh: true` the extension re-reads
	 * `Page.getFrameTree` for the root and every child session first, so the result reflects
	 * Chrome rather than cached state. Used at bootstrap and by target recovery.
	 *
	 * The reply is APPLIED through `SessionManagerEvents.onFrameSnapshot` in wire order
	 * before this resolves — treat the returned snapshot as a completion signal, never
	 * apply it yourself (see handleFrameSnapshot for the ordering hazard).
	 */
	requestFrameSnapshot: (options?: { refresh?: boolean; timeoutMs?: number }) => Promise<ExtensionFrameSnapshot>
}

export type SessionManagerEvents = {
	onAttach: (session: ExtensionSession) => void
	onDetach: (tabId: number, reason: string) => void
	onTargetSelected: (tabId: number, frameId: string | null) => void
	/**
	 * A frame table from the extension (deduplicated pushes AND pull replies — every
	 * snapshot flows through here, synchronously, in wire order). Replaces the pre-C2
	 * stream of synthetic Page.frameNavigated/frameDetached events: apply it wholesale,
	 * idempotently.
	 */
	onFrameSnapshot: (snapshot: ExtensionFrameSnapshot) => void
}

/**
 * Manages CDP sessions with tabs attached via the Chrome extension.
 */
export class SessionManager {
	private messaging: NativeMessagingHandler<ExtensionToTabHost, TabHostToExtension>
	private sessions = new Map<number, ExtensionSession>()
	private readonly nextRequestId = createRequestIdAllocator()
	private readonly pendingRequests = createPendingRequestTable<unknown>({
		timeoutMs: 30_000,
		timeoutMessage: 'Bridge request timed out',
	})
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

			case 'frame_snapshot':
				this.handleFrameSnapshot(message)
				break
		}
	}

	/**
	 * Every snapshot — pushed or pulled — is applied HERE, synchronously, in wire order.
	 *
	 * Routing a pull reply only through its awaiting caller would apply it on a later
	 * microtask, after real cdp_events that arrived behind it on the pipe were already
	 * handled — a stale table would then delete frames those events just created and
	 * selection could rematch onto the wrong frame. Applying in message order makes that
	 * inversion impossible; the settled promise is a completion signal.
	 */
	private handleFrameSnapshot(message: FrameSnapshotMessage): void {
		this.events.onFrameSnapshot(message)
		if (message.requestId != null) {
			this.pendingRequests.settle(message.requestId, message)
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
		if (error) {
			this.pendingRequests.fail(requestId, new Error(error.message))
			return
		}
		this.pendingRequests.settle(requestId, result)
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

			// A per-tab bridge session addresses the whole tab; frame scoping is applied by the
			// delegating session layered on top of it.
			getTargetContext: () => ({ kind: 'page' }),
			getReadyTargetContext: async () => ({ kind: 'page' }),
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
			requestFrameSnapshot: async (options) => {
				if (!this.sessions.has(tabId)) {
					throw createNotAttachedError()
				}
				return this.sendBridgeRequest<ExtensionFrameSnapshot>(
					(requestId) =>
						({
							type: 'frame_snapshot_request',
							requestId,
							tabId,
							refresh: options?.refresh,
						}) satisfies TabHostToExtension,
					options?.timeoutMs ?? 10_000,
				)
			},
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
		const requestId = this.nextRequestId()
		const result = this.pendingRequests.open(requestId, { timeoutMs, timeoutMessage: `Bridge request timed out after ${timeoutMs}ms` })
		this.messaging.send(buildMessage(requestId))
		return result as Promise<T>
	}
}
