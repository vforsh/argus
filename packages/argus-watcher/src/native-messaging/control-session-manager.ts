import type { NativeMessagingHandler } from './messaging.js'
import type {
	ControlDiagnostics,
	ControlHostToExtension,
	ControlStatusResponseMessage,
	ExtensionToControlHost,
	ListTabsResponseMessage,
	TabActionResponseMessage,
	TabInfo,
	TabMuteResponseMessage,
	TabMuteResult,
} from './types.js'

import { createPendingRequestTable, createRequestIdAllocator, type PendingRequestTable } from './pendingRequests.js'
import type { TabActionResult } from './types.js'
export type { TabActionResult } from './types.js'

/** Control-host requests are short round-trips to the extension; five seconds is generous. */
const CONTROL_REQUEST_DEFAULTS = { timeoutMs: 5_000, timeoutMessage: 'Control request timed out' }

export class ControlSessionManager {
	private readonly messaging: NativeMessagingHandler<ExtensionToControlHost, ControlHostToExtension>
	// One id space across all three tables: the extension only sees `requestId` on the wire.
	private readonly nextRequestId = createRequestIdAllocator()
	private readonly pendingTabsRequests = createPendingRequestTable<TabInfo[]>(CONTROL_REQUEST_DEFAULTS)
	private readonly pendingTabActionRequests = createPendingRequestTable<TabActionResult>(CONTROL_REQUEST_DEFAULTS)
	private readonly pendingTabMuteRequests = createPendingRequestTable<TabMuteResult>(CONTROL_REQUEST_DEFAULTS)
	private readonly pendingStatusRequests = createPendingRequestTable<ControlDiagnostics>(CONTROL_REQUEST_DEFAULTS)

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

	async setTabMuted(tabId: number, muted: boolean): Promise<TabMuteResult> {
		return await this.sendRequest(this.pendingTabMuteRequests, 'Set tab mute request timed out', (requestId) => ({
			type: 'set_tab_muted',
			requestId,
			tabId,
			muted,
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
			case 'tab_mute_response':
				this.handleTabMuteResponse(message)
				return
			case 'control_status_response':
				this.handleControlStatusResponse(message)
				return
		}
	}

	private handleListTabsResponse(message: ListTabsResponseMessage): void {
		this.pendingTabsRequests.settle(message.requestId, message.tabs)
	}

	private handleTabActionResponse(message: TabActionResponseMessage): void {
		const result: TabActionResult =
			message.ok && message.tab
				? { ok: true, tab: message.tab, watcherId: message.watcherId }
				: { ok: false, error: message.error?.message ?? 'Tab action failed' }
		this.pendingTabActionRequests.settle(message.requestId, result)
	}

	private handleTabMuteResponse(message: TabMuteResponseMessage): void {
		const result: TabMuteResult =
			message.ok && message.tab && message.muted !== undefined
				? { ok: true, tab: message.tab, muted: message.muted }
				: { ok: false, error: message.error?.message ?? 'Tab mute action failed' }
		this.pendingTabMuteRequests.settle(message.requestId, result)
	}

	private handleControlStatusResponse(message: ControlStatusResponseMessage): void {
		this.pendingStatusRequests.settle(message.requestId, message.diagnostics)
	}

	private async sendRequest<T>(
		requests: PendingRequestTable<T>,
		timeoutMessage: string,
		buildMessage: (requestId: number) => ControlHostToExtension,
	): Promise<T> {
		const requestId = this.nextRequestId()
		const result = requests.open(requestId, { timeoutMessage })
		this.messaging.send(buildMessage(requestId))
		return await result
	}
}
