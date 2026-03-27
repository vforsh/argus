/**
 * Manages chrome.debugger attachment lifecycle.
 * Handles root tab attachment, recursive child-target auto-attach, frame discovery,
 * and session-aware CDP command routing.
 */

type ChildSession = {
	sessionId: string
	targetId: string
	type: string
	url: string
	title: string
	attachedAt: number
	enabledDomains: Set<string>
}

type DebuggeeWithSession = chrome.debugger.Debuggee & {
	sessionId?: string
}

type FrameRecord = {
	frameId: string
	parentFrameId: string | null
	url: string
	title: string | null
	sessionId: string | null
}

export type AttachedTarget = {
	tabId: number
	debuggeeId: chrome.debugger.Debuggee
	url: string
	title: string
	faviconUrl?: string
	attachedAt: number
	enabledDomains: Set<string>
	childSessions: Map<string, ChildSession>
	frames: Map<string, FrameRecord>
	topFrameId: string | null
}

export type CdpEventHandler = (tabId: number, method: string, params: unknown, meta?: { sessionId?: string | null }) => void

export class DebuggerManager {
	private attached = new Map<number, AttachedTarget>()
	private globalEventHandler: CdpEventHandler | null = null
	private detachHandler: ((tabId: number, reason: string) => void) | null = null

	constructor() {
		chrome.debugger.onEvent.addListener((debuggee, method, params) => {
			this.handleCdpEvent(debuggee, method, params)
		})

		chrome.debugger.onDetach.addListener((debuggee, reason) => {
			if (debuggee.tabId) {
				this.handleDetach(debuggee.tabId, (debuggee as DebuggeeWithSession).sessionId ?? null, reason)
			}
		})
	}

	onEvent(handler: CdpEventHandler): void {
		this.globalEventHandler = handler
	}

	onDetach(handler: (tabId: number, reason: string) => void): void {
		this.detachHandler = handler
	}

	async attach(tabId: number): Promise<AttachedTarget> {
		if (this.attached.has(tabId)) {
			return this.attached.get(tabId)!
		}

		const debuggee: chrome.debugger.Debuggee = { tabId }
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
			childSessions: new Map(),
			frames: new Map(),
			topFrameId: null,
		}

		this.attached.set(tabId, target)
		await this.configureAutoAttach(tabId)
		await this.refreshFrameTree(tabId, null)
		return target
	}

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

	async sendCommand<T = unknown>(tabId: number, method: string, params?: Record<string, unknown>, sessionId?: string | null): Promise<T> {
		const target = this.getRequiredTarget(tabId)
		const debuggee = this.toDebuggee(target, sessionId)
		const result = await chrome.debugger.sendCommand(debuggee, method, params)
		return result as T
	}

	async enableDomain(tabId: number, domain: string, sessionId?: string | null): Promise<void> {
		const enabledDomains = this.getRequiredEnabledDomains(tabId, sessionId)
		if (enabledDomains.has(domain)) {
			return
		}

		await this.sendCommand(tabId, `${domain}.enable`, undefined, sessionId)
		enabledDomains.add(domain)
	}

	isAttached(tabId: number): boolean {
		return this.attached.has(tabId)
	}

	listAttached(): AttachedTarget[] {
		return [...this.attached.values()]
	}

	getTarget(tabId: number): AttachedTarget | undefined {
		return this.attached.get(tabId)
	}

	getFrames(tabId: number): FrameRecord[] {
		const target = this.attached.get(tabId)
		if (!target) {
			return []
		}

		return [...target.frames.values()]
	}

	private async configureAutoAttach(tabId: number, sessionId?: string | null): Promise<void> {
		await this.sendCommand(
			tabId,
			'Target.setAutoAttach',
			{
				autoAttach: true,
				waitForDebuggerOnStart: false,
				flatten: true,
				filter: [{ type: 'iframe', exclude: false }],
			},
			sessionId,
		)
	}

	private getEnabledDomains(tabId: number, sessionId?: string | null): Set<string> | null {
		const target = this.attached.get(tabId)
		if (!target) {
			return null
		}

		if (!sessionId) {
			return target.enabledDomains
		}

		return target.childSessions.get(sessionId)?.enabledDomains ?? null
	}

	private getRequiredTarget(tabId: number): AttachedTarget {
		const target = this.attached.get(tabId)
		if (!target) {
			throw new Error(`Tab ${tabId} is not attached`)
		}
		return target
	}

	private getRequiredEnabledDomains(tabId: number, sessionId?: string | null): Set<string> {
		const enabledDomains = this.getEnabledDomains(tabId, sessionId)
		if (!enabledDomains) {
			throw new Error(`Tab ${tabId} is not attached`)
		}
		return enabledDomains
	}

	private toDebuggee(target: AttachedTarget, sessionId?: string | null): chrome.debugger.Debuggee {
		if (!sessionId) {
			return target.debuggeeId
		}

		return { tabId: target.tabId, sessionId } as chrome.debugger.Debuggee
	}

	private handleCdpEvent(debuggee: chrome.debugger.Debuggee, method: string, params?: object): void {
		const tabId = debuggee.tabId
		if (!tabId || !this.attached.has(tabId)) return

		const sessionId = (debuggee as DebuggeeWithSession).sessionId ?? null
		if (method === 'Target.attachedToTarget' && params) {
			void this.handleAttachedToTarget(tabId, params)
			return
		}

		if (method === 'Target.detachedFromTarget' && params) {
			this.handleDetachedFromTarget(tabId, params)
			return
		}

		this.updateStateFromEvent(tabId, sessionId, method, params)

		if (this.globalEventHandler) {
			this.globalEventHandler(tabId, method, params ?? {}, { sessionId })
		}
	}

	private async handleAttachedToTarget(tabId: number, params: object): Promise<void> {
		const target = this.attached.get(tabId)
		if (!target) {
			return
		}

		const record = params as {
			sessionId?: string
			targetInfo?: { targetId?: string; type?: string; title?: string; url?: string }
		}
		if (!record.sessionId) {
			return
		}

		target.childSessions.set(record.sessionId, {
			sessionId: record.sessionId,
			targetId: record.targetInfo?.targetId ?? record.sessionId,
			type: record.targetInfo?.type ?? 'unknown',
			url: record.targetInfo?.url ?? '',
			title: record.targetInfo?.title ?? '',
			attachedAt: Date.now(),
			enabledDomains: new Set(),
		})

		try {
			await this.configureAutoAttach(tabId, record.sessionId)
			await this.enableChildSessionDomains(tabId, record.sessionId)
			await this.refreshFrameTree(tabId, record.sessionId)
		} catch (error) {
			console.warn('[DebuggerManager] Failed to bootstrap child target:', error)
		}
	}

	private async enableChildSessionDomains(tabId: number, sessionId: string): Promise<void> {
		// Keep child sessions aligned with the root tab so watcher features can observe iframe traffic too.
		for (const domain of ['Runtime', 'Page', 'Network'] as const) {
			await this.enableDomain(tabId, domain, sessionId)
		}
	}

	private handleDetachedFromTarget(tabId: number, params: object): void {
		const record = params as { sessionId?: string }
		if (!record.sessionId) {
			return
		}

		this.dropChildSession(tabId, record.sessionId)
	}

	private async refreshFrameTree(tabId: number, sessionId: string | null): Promise<void> {
		const frameTree = (await this.sendCommand(tabId, 'Page.getFrameTree', undefined, sessionId)) as {
			frameTree?: {
				frame?: { id?: string; parentId?: string; name?: string; url?: string }
				childFrames?: unknown[]
			}
		}

		this.mergeFrameTree(tabId, sessionId, frameTree.frameTree)
	}

	private mergeFrameTree(
		tabId: number,
		sessionId: string | null,
		node:
			| {
					frame?: { id?: string; parentId?: string; name?: string; url?: string }
					childFrames?: unknown[]
			  }
			| undefined,
	): void {
		if (!node?.frame?.id) {
			return
		}

		const target = this.attached.get(tabId)
		if (!target) {
			return
		}

		const frameId = node.frame.id
		target.frames.set(frameId, this.toFrameRecord(node.frame, sessionId))

		if (!node.frame.parentId && !sessionId) {
			target.topFrameId = frameId
		}

		if (this.globalEventHandler) {
			this.globalEventHandler(
				tabId,
				'Page.frameNavigated',
				{
					frame: {
						id: frameId,
						parentId: node.frame.parentId ?? null,
						url: node.frame.url ?? '',
						name: node.frame.name ?? null,
					},
				},
				{ sessionId },
			)
		}

		for (const child of node.childFrames ?? []) {
			this.mergeFrameTree(
				tabId,
				sessionId,
				child as {
					frame?: { id?: string; parentId?: string; name?: string; url?: string }
					childFrames?: unknown[]
				},
			)
		}
	}

	private updateStateFromEvent(tabId: number, sessionId: string | null, method: string, params?: object): void {
		const target = this.attached.get(tabId)
		if (!target) {
			return
		}

		if (method === 'Page.frameNavigated' && params) {
			const frame = (params as { frame?: { id?: string; parentId?: string | null; url?: string; name?: string } }).frame
			if (!frame?.id) {
				return
			}

			target.frames.set(frame.id, this.toFrameRecord(frame, sessionId))

			if (!frame.parentId && !sessionId && frame.url) {
				target.url = frame.url
				target.topFrameId = frame.id
			}
			return
		}

		if (method === 'Page.frameAttached' && params) {
			const frame = params as { frameId?: string; parentFrameId?: string }
			if (!frame.frameId) {
				return
			}

			const existing = target.frames.get(frame.frameId)
			target.frames.set(frame.frameId, {
				frameId: frame.frameId,
				parentFrameId: frame.parentFrameId ?? target.topFrameId,
				url: existing?.url ?? '',
				title: existing?.title ?? null,
				sessionId: existing?.sessionId ?? sessionId,
			})
			return
		}

		if (method === 'Page.frameDetached' && params) {
			const frame = params as { frameId?: string }
			if (!frame.frameId) {
				return
			}

			target.frames.delete(frame.frameId)
		}
	}

	private toFrameRecord(frame: { id?: string; parentId?: string | null; url?: string; name?: string }, sessionId: string | null): FrameRecord {
		return {
			frameId: frame.id!,
			parentFrameId: frame.parentId ?? null,
			url: frame.url ?? '',
			title: frame.name ?? null,
			sessionId,
		}
	}

	private handleDetach(tabId: number, sessionId: string | null, reason: string): void {
		const target = this.attached.get(tabId)
		if (!target) {
			return
		}

		if (sessionId) {
			this.dropChildSession(tabId, sessionId)
			return
		}

		this.attached.delete(tabId)
		if (this.detachHandler) {
			this.detachHandler(tabId, reason)
		}
	}

	private dropChildSession(tabId: number, sessionId: string): void {
		const target = this.attached.get(tabId)
		if (!target) {
			return
		}

		target.childSessions.delete(sessionId)
		for (const [frameId, frame] of target.frames.entries()) {
			if (frame.sessionId !== sessionId) {
				continue
			}
			target.frames.delete(frameId)
			this.globalEventHandler?.(tabId, 'Page.frameDetached', { frameId }, { sessionId })
		}
	}
}
