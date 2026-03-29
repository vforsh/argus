import type { HostToExtension } from '../types/messages.js'
import { BridgeClient } from './bridge-client.js'
import { CdpProxy } from './cdp-proxy.js'
import type { DebuggerManager } from './debugger-manager.js'

export type TabWatcherInfo = {
	watcherId: string
	watcherHost: string
	watcherPort: number
	pid: number
}

export type TabTargetInfo = {
	targetId: string
	title: string | null
	url: string | null
	attachedAt: number
}

export type TabBridgeSessionEvents = {
	onWatcherInfo?: (info: TabWatcherInfo) => void
	onTargetInfo?: (info: TabTargetInfo) => void
	onDisconnect?: () => void
}

/**
 * Owns one Native Messaging bridge + one watcher process for a single attached tab.
 * Each session stays tab-scoped so the extension can expose true one-watcher-per-tab semantics.
 */
export class TabBridgeSession {
	private readonly tabId: number
	private readonly bridgeClient: BridgeClient
	private readonly cdpProxy: CdpProxy
	private readonly events: TabBridgeSessionEvents
	private watcherInfo: TabWatcherInfo | null = null
	private targetInfo: TabTargetInfo | null = null
	private lastMessageAt: number | null = null
	private disposed = false

	constructor(tabId: number, debuggerManager: DebuggerManager, events: TabBridgeSessionEvents = {}) {
		this.tabId = tabId
		this.events = events
		this.bridgeClient = new BridgeClient('com.vforsh.argus.bridge', { autoReconnect: false })
		this.cdpProxy = new CdpProxy(debuggerManager, this.bridgeClient)

		this.bridgeClient.onMessage((message) => {
			this.handleMessage(message)
		})
		this.bridgeClient.onDisconnect(() => {
			if (this.disposed) {
				return
			}
			this.events.onDisconnect?.()
		})
	}

	async connectAndAttach(): Promise<void> {
		this.assertOpen()
		const connected = this.bridgeClient.connect()
		if (!connected) {
			throw new Error(`Failed to connect native host for tab ${this.tabId}`)
		}

		await this.cdpProxy.attachTab(this.tabId)
	}

	async detach(): Promise<void> {
		if (this.disposed) {
			return
		}

		try {
			await this.cdpProxy.detachTab(this.tabId)
		} finally {
			this.dispose()
		}
	}

	selectTarget(frameId: string | null): void {
		this.assertOpen()
		const sent = this.bridgeClient.send({
			type: 'target_selected',
			tabId: this.tabId,
			frameId,
		})
		if (!sent) {
			throw new Error(`Failed to select target for tab ${this.tabId}`)
		}
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

	getWatcherInfo(): TabWatcherInfo | null {
		return this.watcherInfo
	}

	getTargetInfo(): TabTargetInfo | null {
		return this.targetInfo
	}

	getLastMessageAt(): number | null {
		return this.lastMessageAt
	}

	private handleMessage(message: HostToExtension): void {
		this.lastMessageAt = Date.now()

		if (message.type === 'host_info') {
			this.watcherInfo = {
				watcherId: message.watcherId,
				watcherHost: message.watcherHost,
				watcherPort: message.watcherPort,
				pid: message.pid,
			}
			this.events.onWatcherInfo?.(this.watcherInfo)
			return
		}

		if (message.type === 'target_info') {
			this.targetInfo = {
				targetId: message.targetId,
				title: message.title,
				url: message.url,
				attachedAt: message.attachedAt,
			}
			this.events.onTargetInfo?.(this.targetInfo)
		}
	}

	private assertOpen(): void {
		if (this.disposed) {
			throw new Error(`Native host session for tab ${this.tabId} is already closed`)
		}
	}
}
