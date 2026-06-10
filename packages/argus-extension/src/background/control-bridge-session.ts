import type { ControlHostToExtension, ExtensionToControlHost, TabInfo } from '../types/messages.js'
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
	onAttachTabWatcher?: (tabId: number) => void | Promise<void>
	onDetachTabWatcher?: (tabId: number) => void | Promise<void>
	getWatcherIdForTab?: (tabId: number) => string | null | undefined
	onDisconnect?: () => void
}

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
				await this.events.onAttachTabWatcher?.(message.tabId)
				return

			case 'detach_tab_watcher':
				await this.events.onDetachTabWatcher?.(message.tabId)
				return

			case 'list_tabs':
				await this.handleListTabs(message.filter)
				return

			case 'host_ready':
				return
		}
	}

	private async handleListTabs(filter?: { url?: string; title?: string }): Promise<void> {
		const tabs: TabInfo[] = await listBrowserTabs(this.debuggerManager, filter, {
			getWatcherIdForTab: this.events.getWatcherIdForTab,
		})
		this.bridgeClient.send({
			type: 'list_tabs_response',
			tabs,
		})
	}

	private assertOpen(): void {
		if (this.disposed) {
			throw new Error('Native host control session is already closed')
		}
	}
}
