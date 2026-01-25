/**
 * Manages chrome.debugger attachment lifecycle.
 * Handles attaching to tabs, sending CDP commands, and receiving events.
 */

export type AttachedTarget = {
	tabId: number
	debuggeeId: chrome.debugger.Debuggee
	url: string
	title: string
	faviconUrl?: string
	attachedAt: number
	enabledDomains: Set<string>
}

export type CdpEventHandler = (tabId: number, method: string, params: unknown) => void

export class DebuggerManager {
	private attached = new Map<number, AttachedTarget>()
	private globalEventHandler: CdpEventHandler | null = null
	private detachHandler: ((tabId: number, reason: string) => void) | null = null

	constructor() {
		// Set up chrome.debugger event listener
		chrome.debugger.onEvent.addListener((debuggee, method, params) => {
			this.handleCdpEvent(debuggee, method, params)
		})

		// Handle debugger detach (user closed orange bar, tab closed, etc.)
		chrome.debugger.onDetach.addListener((debuggee, reason) => {
			if (debuggee.tabId) {
				this.handleDetach(debuggee.tabId, reason)
			}
		})
	}

	/**
	 * Set handler for all CDP events from attached tabs.
	 */
	onEvent(handler: CdpEventHandler): void {
		this.globalEventHandler = handler
	}

	/**
	 * Set handler for tab detachment.
	 */
	onDetach(handler: (tabId: number, reason: string) => void): void {
		this.detachHandler = handler
	}

	/**
	 * Attach to a tab and start receiving CDP events.
	 */
	async attach(tabId: number): Promise<AttachedTarget> {
		if (this.attached.has(tabId)) {
			return this.attached.get(tabId)!
		}

		const debuggee: chrome.debugger.Debuggee = { tabId }

		// Attach to the tab with CDP version 1.3
		await chrome.debugger.attach(debuggee, '1.3')

		const tab = await chrome.tabs.get(tabId)
		const target: AttachedTarget = {
			tabId,
			debuggeeId: debuggee,
			url: tab.url ?? '',
			title: tab.title ?? '',
			faviconUrl: tab.favIconUrl,
			attachedAt: Date.now(),
			enabledDomains: new Set(),
		}

		this.attached.set(tabId, target)
		return target
	}

	/**
	 * Detach from a tab.
	 */
	async detach(tabId: number): Promise<void> {
		const target = this.attached.get(tabId)
		if (!target) return

		try {
			await chrome.debugger.detach(target.debuggeeId)
		} catch {
			// Tab may already be closed
		}
		this.attached.delete(tabId)
	}

	/**
	 * Send a CDP command to an attached tab.
	 */
	async sendCommand<T = unknown>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
		const target = this.attached.get(tabId)
		if (!target) {
			throw new Error(`Tab ${tabId} is not attached`)
		}

		const result = await chrome.debugger.sendCommand(target.debuggeeId, method, params)
		return result as T
	}

	/**
	 * Enable a CDP domain for a tab.
	 */
	async enableDomain(tabId: number, domain: string): Promise<void> {
		const target = this.attached.get(tabId)
		if (!target) {
			throw new Error(`Tab ${tabId} is not attached`)
		}

		if (target.enabledDomains.has(domain)) {
			return // Already enabled
		}

		await this.sendCommand(tabId, `${domain}.enable`)
		target.enabledDomains.add(domain)
	}

	/**
	 * Check if a tab is attached.
	 */
	isAttached(tabId: number): boolean {
		return this.attached.has(tabId)
	}

	/**
	 * Get all attached targets.
	 */
	listAttached(): AttachedTarget[] {
		return [...this.attached.values()]
	}

	/**
	 * Get a specific attached target.
	 */
	getTarget(tabId: number): AttachedTarget | undefined {
		return this.attached.get(tabId)
	}

	/**
	 * Handle CDP events from chrome.debugger.onEvent.
	 */
	private handleCdpEvent(debuggee: chrome.debugger.Debuggee, method: string, params?: object): void {
		const tabId = debuggee.tabId
		if (!tabId || !this.attached.has(tabId)) return

		// Update target info on navigation
		if (method === 'Page.frameNavigated' && params) {
			const frame = (params as { frame?: { url?: string } }).frame
			if (frame?.url) {
				const target = this.attached.get(tabId)
				if (target) {
					target.url = frame.url
				}
			}
		}

		if (this.globalEventHandler) {
			this.globalEventHandler(tabId, method, params ?? {})
		}
	}

	/**
	 * Handle tab detachment from chrome.debugger.onDetach.
	 */
	private handleDetach(tabId: number, reason: string): void {
		const wasAttached = this.attached.has(tabId)
		this.attached.delete(tabId)

		if (wasAttached && this.detachHandler) {
			this.detachHandler(tabId, reason)
		}
	}
}
