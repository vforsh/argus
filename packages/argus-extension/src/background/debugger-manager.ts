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

type CookieQuery = {
	domain?: string
	url?: string
}

type CdpFrameTreeNode = {
	frame?: { id?: string; parentId?: string; name?: string; url?: string }
	childFrames?: CdpFrameTreeNode[]
}

type NativeCookie = {
	name: string
	value: string
	domain: string
	path: string
	secure: boolean
	httpOnly: boolean
	session: boolean
	expires: number | null
	sameSite: string | null
}

const FRAME_TREE_SYNC_DELAY_MS = 150

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
export type DebuggerDetachHandler = (tabId: number, reason: string) => void

export class DebuggerManager {
	private attached = new Map<number, AttachedTarget>()
	private eventHandlers = new Set<CdpEventHandler>()
	private detachHandlers = new Set<DebuggerDetachHandler>()
	private frameTreeSyncTimers = new Map<string, ReturnType<typeof setTimeout>>()

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

	onEvent(handler: CdpEventHandler): () => void {
		this.eventHandlers.add(handler)
		return () => {
			this.eventHandlers.delete(handler)
		}
	}

	onDetach(handler: DebuggerDetachHandler): () => void {
		this.detachHandlers.add(handler)
		return () => {
			this.detachHandlers.delete(handler)
		}
	}

	private emitEvent(tabId: number, method: string, params: unknown, sessionId: string | null): void {
		for (const handler of this.eventHandlers) {
			handler(tabId, method, params, { sessionId })
		}
	}

	private emitDetach(tabId: number, reason: string): void {
		for (const handler of this.detachHandlers) {
			handler(tabId, reason)
		}
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

	/**
	 * Read cookies from the attached tab's cookie store so extension-mode auth export can keep
	 * sibling subdomain session cookies such as `auth.example.com`.
	 */
	async getCookies(tabId: number, query: CookieQuery = {}): Promise<NativeCookie[]> {
		this.getRequiredTarget(tabId)
		const storeId = await this.findCookieStoreId(tabId)
		const cookies = await chrome.cookies.getAll({
			domain: query.domain,
			storeId: storeId ?? undefined,
			url: query.domain ? undefined : query.url,
		})

		return cookies.map((cookie) => ({
			name: cookie.name,
			value: cookie.value,
			domain: cookie.domain,
			path: cookie.path,
			secure: cookie.secure,
			httpOnly: cookie.httpOnly,
			session: cookie.session,
			expires: typeof cookie.expirationDate === 'number' ? cookie.expirationDate : null,
			sameSite: cookie.sameSite ?? null,
		}))
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

	private async findCookieStoreId(tabId: number): Promise<string | null> {
		const stores = await chrome.cookies.getAllCookieStores()
		const store = stores.find((candidate) => candidate.tabIds.includes(tabId))
		return store?.id ?? null
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
		this.emitEvent(tabId, method, params ?? {}, sessionId)
		this.scheduleFrameTreeSyncIfNeeded(tabId, sessionId, method, params)
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

		this.clearFrameTreeSync(record.sessionId, tabId)
		this.dropChildSession(tabId, record.sessionId)
	}

	private async refreshFrameTree(tabId: number, sessionId: string | null): Promise<void> {
		const result = (await this.sendCommand(tabId, 'Page.getFrameTree', undefined, sessionId)) as { frameTree?: CdpFrameTreeNode }
		this.replaceFrameTreeSnapshot(tabId, sessionId, result.frameTree)
	}

	/**
	 * Each `Page.getFrameTree` result is a full snapshot for that session, so merge the refreshed
	 * nodes and then prune frames from the same session that no longer exist after reload.
	 */
	private replaceFrameTreeSnapshot(tabId: number, sessionId: string | null, node: CdpFrameTreeNode | undefined): void {
		if (!node?.frame?.id) {
			return
		}

		const target = this.attached.get(tabId)
		if (!target) {
			return
		}

		const nextFrameIds = new Set<string>()
		this.mergeFrameTree(tabId, sessionId, node, nextFrameIds)
		this.pruneMissingSessionFrames(tabId, sessionId, nextFrameIds)
	}

	private mergeFrameTree(tabId: number, sessionId: string | null, node: CdpFrameTreeNode | undefined, nextFrameIds: Set<string>): void {
		if (!node?.frame?.id) {
			return
		}

		const target = this.attached.get(tabId)
		if (!target) {
			return
		}

		const frameId = node.frame.id
		nextFrameIds.add(frameId)
		target.frames.set(frameId, this.toFrameRecord(node.frame, sessionId))

		if (!node.frame.parentId && !sessionId) {
			target.topFrameId = frameId
		}

		this.emitEvent(
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
			sessionId,
		)

		for (const child of node.childFrames ?? []) {
			this.mergeFrameTree(tabId, sessionId, child, nextFrameIds)
		}
	}

	private pruneMissingSessionFrames(tabId: number, sessionId: string | null, nextFrameIds: Set<string>): void {
		const target = this.attached.get(tabId)
		if (!target) {
			return
		}

		for (const [frameId, frame] of target.frames.entries()) {
			if (frame.sessionId !== sessionId || nextFrameIds.has(frameId)) {
				continue
			}

			target.frames.delete(frameId)
			this.emitEvent(tabId, 'Page.frameDetached', { frameId }, sessionId)
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

	/**
	 * Chrome's frame attach/detach events during reload are not always complete. When the root frame
	 * for a session navigates, refresh that session's full frame tree shortly afterward and treat it
	 * as authoritative so stale iframe records do not linger in extension state.
	 */
	private scheduleFrameTreeSyncIfNeeded(tabId: number, sessionId: string | null, method: string, params?: object): void {
		if (!shouldSyncFrameTreeSnapshot(method, params)) {
			return
		}

		const key = getFrameTreeSyncKey(tabId, sessionId)
		if (this.frameTreeSyncTimers.has(key)) {
			return
		}

		const timer = setTimeout(() => {
			this.frameTreeSyncTimers.delete(key)
			void this.refreshFrameTree(tabId, sessionId).catch((error) => {
				console.warn('[DebuggerManager] Failed to refresh frame tree after navigation:', error)
			})
		}, FRAME_TREE_SYNC_DELAY_MS)

		this.frameTreeSyncTimers.set(key, timer)
	}

	private clearFrameTreeSync(sessionId: string | null, tabId: number): void {
		const key = getFrameTreeSyncKey(tabId, sessionId)
		const timer = this.frameTreeSyncTimers.get(key)
		if (!timer) {
			return
		}

		clearTimeout(timer)
		this.frameTreeSyncTimers.delete(key)
	}

	private clearAllFrameTreeSync(tabId: number): void {
		for (const [key, timer] of this.frameTreeSyncTimers.entries()) {
			if (!key.startsWith(`${tabId}:`)) {
				continue
			}

			clearTimeout(timer)
			this.frameTreeSyncTimers.delete(key)
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

		this.clearFrameTreeSync(sessionId, tabId)

		if (sessionId) {
			this.dropChildSession(tabId, sessionId)
			return
		}

		this.clearAllFrameTreeSync(tabId)
		this.attached.delete(tabId)
		this.emitDetach(tabId, reason)
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
			this.emitEvent(tabId, 'Page.frameDetached', { frameId }, sessionId)
		}
	}
}

function shouldSyncFrameTreeSnapshot(method: string, params?: object): boolean {
	if (method !== 'Page.frameNavigated' || !params) {
		return false
	}

	const frame = (params as { frame?: { parentId?: string | null } }).frame
	return frame?.parentId == null
}

function getFrameTreeSyncKey(tabId: number, sessionId: string | null): string {
	return `${tabId}:${sessionId ?? 'root'}`
}
