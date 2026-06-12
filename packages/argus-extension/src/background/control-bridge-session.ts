import type { ControlDiagnostics, ControlHostToExtension, ExtensionToControlHost, TabInfo } from '../types/messages.js'
import { BridgeClient } from './bridge-client.js'
import type { DebuggerManager } from './debugger-manager.js'
import { CONTROL_HOST_NAME } from './native-hosts.js'
import { listBrowserTabs } from './tab-list.js'

export type ControlWatcherInfo = {
	watcherId: string
	watcherHost: string
	watcherPort: number
	pid: number
}

export type ControlBridgeSessionEvents = {
	onWatcherInfo?: (info: ControlWatcherInfo) => void
	onAttachTabWatcher?: (tabId: number, options: { watcherId?: string }) => Promise<TabActionResult>
	onDetachTabWatcher?: (tabId: number) => Promise<TabActionResult>
	getWatcherIdForTab?: (tabId: number) => string | null | undefined
	getDiagnostics?: () => ControlDiagnostics
	onDisconnect?: () => void
}

export type TabActionResult = { ok: true; tab: TabInfo; watcherId?: string } | { ok: false; error: string }

/**
 * Owns the extension-level native host. It never attaches chrome.debugger to a tab;
 * it only gives Argus a stable HTTP transport for browser-level extension commands.
 */
export class ControlBridgeSession {
	private readonly bridgeClient: BridgeClient<ControlHostToExtension, ExtensionToControlHost>
	private readonly debuggerManager: DebuggerManager
	private readonly events: ControlBridgeSessionEvents
	private watcherInfo: ControlWatcherInfo | null = null
	private lastMessageAt: number | null = null
	private disposed = false

	constructor(debuggerManager: DebuggerManager, events: ControlBridgeSessionEvents = {}) {
		this.debuggerManager = debuggerManager
		this.events = events
		this.bridgeClient = new BridgeClient(CONTROL_HOST_NAME, { autoReconnect: true })

		this.bridgeClient.onMessage((message) => {
			void this.handleMessage(message)
		})
		this.bridgeClient.onDisconnect(() => {
			if (this.disposed) {
				return
			}
			this.events.onDisconnect?.()
		})
	}

	connect(): boolean {
		this.assertOpen()
		return this.bridgeClient.connect()
	}

	dispose(): void {
		if (this.disposed) {
			return
		}

		this.disposed = true
		this.bridgeClient.disconnect()
	}

	isConnected(): boolean {
		return this.bridgeClient.isConnected()
	}

	getWatcherInfo(): ControlWatcherInfo | null {
		return this.watcherInfo
	}

	getLastMessageAt(): number | null {
		return this.lastMessageAt
	}

	private async handleMessage(message: ControlHostToExtension): Promise<void> {
		this.lastMessageAt = Date.now()

		switch (message.type) {
			case 'host_info':
				this.watcherInfo = {
					watcherId: message.watcherId,
					watcherHost: message.watcherHost,
					watcherPort: message.watcherPort,
					pid: message.pid,
				}
				this.events.onWatcherInfo?.(this.watcherInfo)
				return

			case 'attach_tab_watcher':
				await this.handleTabAction(message.requestId, () => this.events.onAttachTabWatcher?.(message.tabId, { watcherId: message.watcherId }))
				return

			case 'detach_tab_watcher':
				await this.handleTabAction(message.requestId, () => this.events.onDetachTabWatcher?.(message.tabId))
				return

			case 'list_tabs':
				await this.handleListTabs(message.requestId, message.filter)
				return

			case 'control_status':
				this.handleControlStatus(message.requestId)
				return

			case 'host_ready':
				return
		}
	}

	private async handleTabAction(requestId: number, action: () => Promise<TabActionResult> | undefined): Promise<void> {
		try {
			const result = (await action()) ?? { ok: false, error: 'Extension control action is not available' }
			if (!result.ok) {
				this.bridgeClient.send({ type: 'tab_action_response', requestId, ok: false, error: { message: result.error } })
				return
			}

			this.bridgeClient.send({ type: 'tab_action_response', requestId, ok: true, tab: result.tab, watcherId: result.watcherId })
		} catch (error) {
			this.bridgeClient.send({
				type: 'tab_action_response',
				requestId,
				ok: false,
				error: { message: error instanceof Error ? error.message : String(error) },
			})
		}
	}

	private async handleListTabs(requestId: number, filter?: { url?: string; title?: string }): Promise<void> {
		const tabs: TabInfo[] = await listBrowserTabs(this.debuggerManager, filter, {
			getWatcherIdForTab: this.events.getWatcherIdForTab,
		})
		this.bridgeClient.send({
			type: 'list_tabs_response',
			requestId,
			tabs,
		})
	}

	private handleControlStatus(requestId: number): void {
		this.bridgeClient.send({
			type: 'control_status_response',
			requestId,
			diagnostics: this.events.getDiagnostics?.() ?? this.buildFallbackDiagnostics(),
		})
	}

	private buildFallbackDiagnostics(): ControlDiagnostics {
		return {
			extensionId: null,
			extensionVersion: null,
			control: {
				connected: this.isConnected(),
				watcherId: this.watcherInfo?.watcherId ?? null,
				watcherHost: this.watcherInfo?.watcherHost ?? null,
				watcherPort: this.watcherInfo?.watcherPort ?? null,
				pid: this.watcherInfo?.pid ?? null,
				lastMessageAt: this.lastMessageAt,
			},
			tabWatchers: [],
			recentEvents: [],
		}
	}

	private assertOpen(): void {
		if (this.disposed) {
			throw new Error('Native host control session is already closed')
		}
	}
}
