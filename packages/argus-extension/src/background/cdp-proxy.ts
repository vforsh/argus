/**
 * CDP Proxy - Routes CDP commands and events between the Native Messaging
 * host (argus-watcher in extension mode) and the chrome.debugger API.
 */

import type { DebuggerManager } from './debugger-manager.js'
import type { BridgeClient } from './bridge-client.js'
import type {
	HostToExtension,
	CdpCommandMessage,
	AttachTabMessage,
	DetachTabMessage,
	EnableDomainMessage,
	TabInfo,
	CookieQueryMessage,
} from '../types/messages.js'
import { listBrowserTabs } from './tab-list.js'

export class CdpProxy {
	private debuggerManager: DebuggerManager
	private bridgeClient: BridgeClient
	private removeDebuggerEventForwarding: (() => void) | null = null
	private removeDebuggerDetachForwarding: (() => void) | null = null

	constructor(debuggerManager: DebuggerManager, bridgeClient: BridgeClient) {
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
	}

	dispose(): void {
		this.removeDebuggerEventForwarding?.()
		this.removeDebuggerEventForwarding = null
		this.removeDebuggerDetachForwarding?.()
		this.removeDebuggerDetachForwarding = null
	}

	/**
	 * Handle messages from the bridge.
	 */
	private setupMessageHandling(): void {
		this.bridgeClient.onMessage((message: HostToExtension) => {
			this.handleMessage(message)
		})
	}

	/**
	 * Process a message from the bridge.
	 */
	private async handleMessage(message: HostToExtension): Promise<void> {
		switch (message.type) {
			case 'attach_tab':
				await this.handleAttachTab(message)
				break

			case 'detach_tab':
				await this.handleDetachTab(message)
				break

			case 'cdp_command':
				await this.handleCdpCommand(message)
				break

			case 'cookie_query':
				await this.handleCookieQuery(message)
				break

			case 'list_tabs':
				await this.handleListTabs(message)
				break

			case 'enable_domain':
				await this.handleEnableDomain(message)
				break

			case 'host_info':
			case 'target_info':
				break

			default:
				console.warn('[CdpProxy] Unknown message type:', (message as { type: string }).type)
		}
	}

	/**
	 * Attach to a tab.
	 */
	private async handleAttachTab(message: AttachTabMessage): Promise<void> {
		try {
			const target = await this.debuggerManager.attach(message.tabId)

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
				tabId: message.tabId,
				reason: err instanceof Error ? err.message : 'attach_failed',
			})
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
	 * List available tabs.
	 */
	private async handleListTabs(message: { filter?: { url?: string; title?: string } }): Promise<void> {
		const tabs: TabInfo[] = await listBrowserTabs(this.debuggerManager, message.filter)

		this.bridgeClient.send({
			type: 'list_tabs_response',
			tabs,
		})
	}

	/**
	 * Enable a CDP domain for a tab.
	 */
	private async handleEnableDomain(message: EnableDomainMessage): Promise<void> {
		try {
			await this.debuggerManager.enableDomain(message.tabId, message.domain)
		} catch (err) {
			console.error('[CdpProxy] Failed to enable domain:', err)
		}
	}

	/**
	 * Manually attach to a tab (called from popup).
	 */
	async attachTab(tabId: number): Promise<void> {
		await this.handleAttachTab({ type: 'attach_tab', tabId })
	}

	/**
	 * Manually detach from a tab (called from popup).
	 */
	async detachTab(tabId: number): Promise<void> {
		await this.debuggerManager.detach(tabId)
		this.bridgeClient.send({
			type: 'tab_detached',
			tabId,
			reason: 'user_requested',
		})
	}

	/**
	 * Get list of tabs for popup UI.
	 */
	async getTabsForPopup(): Promise<TabInfo[]> {
		return await listBrowserTabs(this.debuggerManager)
	}
}
