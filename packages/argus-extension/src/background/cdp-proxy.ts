/**
 * CDP Proxy - Routes CDP commands and events between the Native Messaging
 * host (argus-watcher in extension mode) and the chrome.debugger API.
 */

import type { DebuggerManager } from './debugger-manager.js'
import type { BridgeClient } from './bridge-client.js'
import type {
	CdpCommandMessage,
	DetachTabMessage,
	CookieQueryMessage,
	ExtensionToTabHost,
	FrameSnapshotRequestMessage,
	TabHostToExtension,
} from '../types/messages.js'

export class CdpProxy {
	private debuggerManager: DebuggerManager
	private bridgeClient: BridgeClient<TabHostToExtension, ExtensionToTabHost>
	private removeDebuggerEventForwarding: (() => void) | null = null
	private removeDebuggerDetachForwarding: (() => void) | null = null
	private removeFramesChangedForwarding: (() => void) | null = null

	constructor(debuggerManager: DebuggerManager, bridgeClient: BridgeClient<TabHostToExtension, ExtensionToTabHost>) {
		this.debuggerManager = debuggerManager
		this.bridgeClient = bridgeClient

		this.setupEventForwarding()
		this.setupMessageHandling()
	}

	/**
	 * Forward CDP events from debugger to bridge.
	 */
	private setupEventForwarding(): void {
		this.removeDebuggerEventForwarding = this.debuggerManager.onEvent((tabId, method, params, meta) => {
			this.bridgeClient.send({
				type: 'cdp_event',
				tabId,
				method,
				params,
				sessionId: meta?.sessionId ?? undefined,
			})
		})

		this.removeDebuggerDetachForwarding = this.debuggerManager.onDetach((tabId, reason) => {
			this.bridgeClient.send({
				type: 'tab_detached',
				tabId,
				reason,
			})
		})

		// The authoritative frame table travels as full snapshots, never as fabricated
		// Page.frameNavigated/frameDetached events. The watcher filters by tabId.
		this.removeFramesChangedForwarding = this.debuggerManager.onFramesChanged((tabId, reason) => {
			this.bridgeClient.send({
				type: 'frame_snapshot',
				tabId,
				reason,
				...this.debuggerManager.getFrameSnapshot(tabId),
			})
		})
	}

	dispose(): void {
		this.removeDebuggerEventForwarding?.()
		this.removeDebuggerEventForwarding = null
		this.removeDebuggerDetachForwarding?.()
		this.removeDebuggerDetachForwarding = null
		this.removeFramesChangedForwarding?.()
		this.removeFramesChangedForwarding = null
	}

	/**
	 * Handle messages from the bridge.
	 */
	private setupMessageHandling(): void {
		this.bridgeClient.onMessage((message) => {
			void this.handleMessage(message).catch((error) => {
				console.error('[CdpProxy] Failed to handle bridge message:', error)
			})
		})
	}

	/**
	 * Process a message from the bridge.
	 */
	private async handleMessage(message: TabHostToExtension): Promise<void> {
		switch (message.type) {
			case 'detach_tab':
				await this.handleDetachTab(message)
				break

			case 'cdp_command':
				await this.handleCdpCommand(message)
				break

			case 'cookie_query':
				await this.handleCookieQuery(message)
				break

			case 'frame_snapshot_request':
				await this.handleFrameSnapshotRequest(message)
				break

			case 'host_info':
			case 'host_ready':
			case 'target_info':
				break

			default:
				console.warn('[CdpProxy] Unknown message type:', (message as { type: string }).type)
		}
	}

	/**
	 * Attach to a tab (driven by the popup; the host never requests attachment).
	 */
	async attachTab(tabId: number): Promise<void> {
		try {
			const target = await this.debuggerManager.attach(tabId)

			this.bridgeClient.send({
				type: 'tab_attached',
				tabId: target.tabId,
				url: target.url,
				title: target.title,
				faviconUrl: target.faviconUrl,
				topFrameId: target.topFrameId,
				frames: this.debuggerManager.getFrames(target.tabId),
			})
		} catch (err) {
			console.error('[CdpProxy] Failed to attach:', err)
			this.bridgeClient.send({
				type: 'tab_detached',
				tabId,
				reason: err instanceof Error ? err.message : 'attach_failed',
			})
			throw err
		}
	}

	/**
	 * Detach from a tab.
	 */
	private async handleDetachTab(message: DetachTabMessage): Promise<void> {
		await this.debuggerManager.detach(message.tabId)
	}

	/**
	 * Execute a CDP command.
	 */
	private async handleCdpCommand(message: CdpCommandMessage): Promise<void> {
		try {
			const result = await this.debuggerManager.sendCommand(message.tabId, message.method, message.params, message.sessionId)

			this.bridgeClient.send({
				type: 'cdp_response',
				requestId: message.requestId,
				result,
			})
		} catch (err) {
			this.bridgeClient.send({
				type: 'cdp_response',
				requestId: message.requestId,
				error: {
					message: err instanceof Error ? err.message : 'Unknown error',
				},
			})
		}
	}

	/**
	 * Answer a watcher pull for the frame table. With `refresh` the table is re-read from
	 * Chrome first; either way the reply is the full current table, so applying it is
	 * idempotent on the watcher side.
	 */
	private async handleFrameSnapshotRequest(message: FrameSnapshotRequestMessage): Promise<void> {
		let snapshot
		try {
			snapshot = message.refresh ? await this.debuggerManager.resyncFrames(message.tabId) : this.debuggerManager.getFrameSnapshot(message.tabId)
		} catch {
			// Tab not attached (or resync raced a detach); answer with what we have so the
			// watcher's request resolves instead of timing out.
			snapshot = this.debuggerManager.getFrameSnapshot(message.tabId)
		}

		this.bridgeClient.send({
			type: 'frame_snapshot',
			tabId: message.tabId,
			reason: 'requested',
			requestId: message.requestId,
			...snapshot,
		})
	}

	/**
	 * Query browser cookies from the attached tab's cookie store.
	 */
	private async handleCookieQuery(message: CookieQueryMessage): Promise<void> {
		try {
			const cookies = await this.debuggerManager.getCookies(message.tabId, {
				domain: message.domain,
				url: message.url,
			})

			this.bridgeClient.send({
				type: 'cookie_query_response',
				requestId: message.requestId,
				cookies,
			})
		} catch (err) {
			this.bridgeClient.send({
				type: 'cookie_query_response',
				requestId: message.requestId,
				error: {
					message: err instanceof Error ? err.message : 'Unknown error',
				},
			})
		}
	}

	/**
	 * Manually detach from a tab (called from popup).
	 */
	async detachTab(tabId: number): Promise<void> {
		this.bridgeClient.send({
			type: 'tab_detached',
			tabId,
			reason: 'user_requested',
		})
		await this.debuggerManager.detach(tabId)
	}
}
