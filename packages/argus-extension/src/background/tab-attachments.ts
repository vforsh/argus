import type { DebuggerManager } from './debugger-manager.js'
import { TabBridgeSession, type TabBridgeSessionOptions, type TabBridgeSessionEvents, type TabWatcherInfo } from './tab-bridge-session.js'
import { TabOperationQueue } from './tab-operation-queue.js'
import type { RememberedTargetSelection } from './target-selection-history.js'

/** Session and selection state share one lifetime, including while attachment is pending. */
export type TabAttachment = {
	session: TabBridgeSession
	selectedFrameId?: string | null
	pendingRememberedTarget?: RememberedTargetSelection
}

type Events = Omit<TabBridgeSessionEvents, 'onDisconnect' | 'onWatcherInfo'> & {
	onWatcherInfo: (info: TabWatcherInfo, tabId: number) => void
	onDisconnect: (tabId: number) => void
	onError: (error: unknown) => void
}

/** Owns per-tab native sessions and serializes their debugger lifecycle. */
export class TabAttachments {
	readonly records = new Map<number, TabAttachment>()
	private readonly operations = new TabOperationQueue()

	constructor(
		private readonly debuggerManager: DebuggerManager,
		private readonly events: Events,
	) {}

	/** Reuse an initialized session; simultaneous callers wait for the same tab's transition. */
	attach(tabId: number, options: TabBridgeSessionOptions = {}): Promise<TabBridgeSession> {
		return this.operations.run(tabId, () => this.createSession(tabId, options))
	}

	private async createSession(tabId: number, options: TabBridgeSessionOptions): Promise<TabBridgeSession> {
		const existing = this.records.get(tabId)?.session
		if (existing) return existing

		const session = new TabBridgeSession(
			tabId,
			this.debuggerManager,
			{
				onTargetInfo: this.events.onTargetInfo,
				onWatcherInfo: (info) => this.events.onWatcherInfo(info, tabId),
				onDisconnect: () => this.handleDisconnect(tabId, session),
			},
			options,
		)
		this.records.set(tabId, { session })
		try {
			await session.connectAndAttach()
			return session
		} catch (error) {
			if (this.records.get(tabId)?.session === session) this.forget(tabId)
			throw error
		}
	}

	private handleDisconnect(tabId: number, session: TabBridgeSession): void {
		void this.operations
			.run(tabId, async () => {
				// A late callback from an old host must never tear down its replacement.
				if (this.records.get(tabId)?.session !== session) return
				await this.release(tabId)
				this.events.onDisconnect(tabId)
			})
			.catch(this.events.onError)
	}

	/** Release the debugger and native session, including an untracked Chrome attachment. */
	detach(tabId: number): Promise<void> {
		return this.operations.run(tabId, () => this.release(tabId))
	}

	private async release(tabId: number): Promise<void> {
		const session = this.records.get(tabId)?.session
		if (session) await session.detach()
		else await this.debuggerManager.detach(tabId)
		this.forget(tabId)
	}

	/** Drop native/selection state after Chrome has reported a debugger detach. */
	forget(tabId: number): void {
		const attachment = this.records.get(tabId)
		if (!attachment) return
		this.records.delete(tabId)
		attachment.session.dispose()
	}
}
