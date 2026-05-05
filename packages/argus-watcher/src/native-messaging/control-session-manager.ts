import type { NativeMessagingHandler } from './messaging.js'
import type { ControlHostToExtension, ExtensionToControlHost, ListTabsResponseMessage, TabInfo } from './types.js'

export class ControlSessionManager {
	private readonly messaging: NativeMessagingHandler<ExtensionToControlHost, ControlHostToExtension>
	private pendingTabsRequest: {
		resolve: (tabs: TabInfo[]) => void
		reject: (error: Error) => void
	} | null = null

	constructor(messaging: NativeMessagingHandler<ExtensionToControlHost, ControlHostToExtension>) {
		this.messaging = messaging
		this.messaging.onMessage((message) => {
			this.handleMessage(message)
		})
	}

	attachTabWatcher(tabId: number): void {
		this.messaging.send({
			type: 'attach_tab_watcher',
			tabId,
		})
	}

	detachTabWatcher(tabId: number): void {
		this.messaging.send({
			type: 'detach_tab_watcher',
			tabId,
		})
	}

	async listTabs(filter?: { url?: string; title?: string }): Promise<TabInfo[]> {
		return new Promise((resolve, reject) => {
			this.pendingTabsRequest = { resolve, reject }
			this.messaging.send({
				type: 'list_tabs',
				filter,
			})

			setTimeout(() => {
				if (!this.pendingTabsRequest) {
					return
				}
				this.pendingTabsRequest.reject(new Error('List tabs request timed out'))
				this.pendingTabsRequest = null
			}, 5000)
		})
	}

	private handleMessage(message: ExtensionToControlHost): void {
		switch (message.type) {
			case 'list_tabs_response':
				this.handleListTabsResponse(message)
				return
		}
	}

	private handleListTabsResponse(message: ListTabsResponseMessage): void {
		this.pendingTabsRequest?.resolve(message.tabs)
		this.pendingTabsRequest = null
	}
}
