/**
 * CDP Proxy - Routes CDP commands and events between the Native Messaging
 * host (argus-watcher in extension mode) and the chrome.debugger API.
 */

import type { DebuggerManager } from './debugger-manager.js'
import type { BridgeClient } from './bridge-client.js'
import type { HostToExtension, CdpCommandMessage, AttachTabMessage, DetachTabMessage, EnableDomainMessage, TabInfo } from '../types/messages.js'

export class CdpProxy {
	private debuggerManager: DebuggerManager
	private bridgeClient: BridgeClient

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
		this.debuggerManager.onEvent((tabId, method, params) => {
			this.bridgeClient.send({
				type: 'cdp_event',
				tabId,
				method,
				params,
			})
		})

		this.debuggerManager.onDetach((tabId, reason) => {
			this.bridgeClient.send({
				type: 'tab_detached',
				tabId,
				reason,
			})
		})
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

			case 'list_tabs':
				await this.handleListTabs(message)
				break

			case 'enable_domain':
				await this.handleEnableDomain(message)
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

			// Enable core domains needed for Argus functionality
			await this.debuggerManager.enableDomain(message.tabId, 'Runtime')
			await this.debuggerManager.enableDomain(message.tabId, 'Page')

			this.bridgeClient.send({
				type: 'tab_attached',
				tabId: target.tabId,
				url: target.url,
				title: target.title,
				faviconUrl: target.faviconUrl,
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
			const result = await this.debuggerManager.sendCommand(message.tabId, message.method, message.params)

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
	 * List available tabs.
	 */
	private async handleListTabs(message: { filter?: { url?: string; title?: string } }): Promise<void> {
		const chromeTabs = await chrome.tabs.query({})
		const attachedTargets = this.debuggerManager.listAttached()
		const attachedTabIds = new Set(attachedTargets.map((t) => t.tabId))

		let tabs: TabInfo[] = chromeTabs
			.filter((tab) => tab.id !== undefined && tab.url !== undefined)
			.map((tab) => ({
				tabId: tab.id!,
				url: tab.url!,
				title: tab.title ?? '',
				faviconUrl: tab.favIconUrl,
				attached: attachedTabIds.has(tab.id!),
			}))

		// Apply filters if provided
		if (message.filter) {
			if (message.filter.url) {
				const urlFilter = message.filter.url.toLowerCase()
				tabs = tabs.filter((t) => t.url.toLowerCase().includes(urlFilter))
			}
			if (message.filter.title) {
				const titleFilter = message.filter.title.toLowerCase()
				tabs = tabs.filter((t) => t.title.toLowerCase().includes(titleFilter))
			}
		}

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
		const chromeTabs = await chrome.tabs.query({})
		const attachedTargets = this.debuggerManager.listAttached()
		const attachedTabIds = new Set(attachedTargets.map((t) => t.tabId))

		return chromeTabs
			.filter((tab) => tab.id !== undefined && tab.url !== undefined)
			.filter((tab) => !tab.url!.startsWith('chrome://') && !tab.url!.startsWith('chrome-extension://'))
			.map((tab) => ({
				tabId: tab.id!,
				url: tab.url!,
				title: tab.title ?? '',
				faviconUrl: tab.favIconUrl,
				attached: attachedTabIds.has(tab.id!),
			}))
	}
}
