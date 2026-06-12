import type { NativeMessagingHandler } from './messaging.js'
import type {
	ControlDiagnostics,
	ControlHostToExtension,
	ControlStatusResponseMessage,
	ExtensionToControlHost,
	ListTabsResponseMessage,
	TabActionResponseMessage,
	TabInfo,
} from './types.js'

type PendingRequest<T> = {
	resolve: (value: T) => void
	reject: (error: Error) => void
	timeout: ReturnType<typeof setTimeout>
}

export type TabActionResult = { ok: true; tab: TabInfo; watcherId?: string } | { ok: false; error: string }

export class ControlSessionManager {
	private readonly messaging: NativeMessagingHandler<ExtensionToControlHost, ControlHostToExtension>
	private nextRequestId = 1
	private readonly pendingTabsRequests = new Map<number, PendingRequest<TabInfo[]>>()
	private readonly pendingTabActionRequests = new Map<number, PendingRequest<TabActionResult>>()
	private readonly pendingStatusRequests = new Map<number, PendingRequest<ControlDiagnostics>>()

	constructor(messaging: NativeMessagingHandler<ExtensionToControlHost, ControlHostToExtension>) {
		this.messaging = messaging
		this.messaging.onMessage((message) => {
			this.handleMessage(message)
		})
	}

	async attachTabWatcher(tabId: number, options: { watcherId?: string } = {}): Promise<TabActionResult> {
		return await this.sendRequest(this.pendingTabActionRequests, 'Attach tab request timed out', (requestId) => ({
			type: 'attach_tab_watcher',
			requestId,
			tabId,
			watcherId: options.watcherId,
		}))
	}

	async detachTabWatcher(tabId: number): Promise<TabActionResult> {
		return await this.sendRequest(this.pendingTabActionRequests, 'Detach tab request timed out', (requestId) => ({
			type: 'detach_tab_watcher',
			requestId,
			tabId,
		}))
	}

	async listTabs(filter?: { url?: string; title?: string }): Promise<TabInfo[]> {
		return await this.sendRequest(this.pendingTabsRequests, 'List tabs request timed out', (requestId) => ({
			type: 'list_tabs',
			requestId,
			filter,
		}))
	}

	async getDiagnostics(): Promise<ControlDiagnostics> {
		return await this.sendRequest(this.pendingStatusRequests, 'Control status request timed out', (requestId) => ({
			type: 'control_status',
			requestId,
		}))
	}

	private handleMessage(message: ExtensionToControlHost): void {
		switch (message.type) {
			case 'list_tabs_response':
				this.handleListTabsResponse(message)
				return
			case 'tab_action_response':
				this.handleTabActionResponse(message)
				return
			case 'control_status_response':
				this.handleControlStatusResponse(message)
				return
		}
	}

	private handleListTabsResponse(message: ListTabsResponseMessage): void {
		this.resolvePending(this.pendingTabsRequests, message.requestId, message.tabs)
	}

	private handleTabActionResponse(message: TabActionResponseMessage): void {
		const result: TabActionResult =
			message.ok && message.tab
				? { ok: true, tab: message.tab, watcherId: message.watcherId }
				: { ok: false, error: message.error?.message ?? 'Tab action failed' }
		this.resolvePending(this.pendingTabActionRequests, message.requestId, result)
	}

	private handleControlStatusResponse(message: ControlStatusResponseMessage): void {
		this.resolvePending(this.pendingStatusRequests, message.requestId, message.diagnostics)
	}

	private allocateRequestId(): number {
		const requestId = this.nextRequestId
		this.nextRequestId += 1
		return requestId
	}

	private async sendRequest<T>(
		requests: Map<number, PendingRequest<T>>,
		timeoutMessage: string,
		buildMessage: (requestId: number) => ControlHostToExtension,
	): Promise<T> {
		const requestId = this.allocateRequestId()
		const result = this.createPendingRequest(requests, requestId, timeoutMessage)
		this.messaging.send(buildMessage(requestId))
		return await result
	}

	private createPendingRequest<T>(requests: Map<number, PendingRequest<T>>, requestId: number, timeoutMessage: string): Promise<T> {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				requests.delete(requestId)
				reject(new Error(timeoutMessage))
			}, 5000)
			requests.set(requestId, { resolve, reject, timeout })
		})
	}

	private resolvePending<T>(requests: Map<number, PendingRequest<T>>, requestId: number, value: T): void {
		const pending = requests.get(requestId)
		if (!pending) {
			return
		}

		clearTimeout(pending.timeout)
		requests.delete(requestId)
		pending.resolve(value)
	}
}
