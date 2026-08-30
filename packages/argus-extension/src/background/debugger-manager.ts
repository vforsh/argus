/**
 * Manages chrome.debugger attachment lifecycle.
 * Handles root tab attachment, recursive child-target auto-attach, frame discovery,
 * and session-aware CDP command routing.
 *
 * Frame bookkeeping contract (C2): this class owns the authoritative frame table per tab
 * (mutated via `frame-table.ts`). Only REAL Chrome CDP events are re-emitted through
 * `onEvent`; snapshot merges and session detaches never fabricate `Page.frameNavigated`/
 * `Page.frameDetached`. Instead, table changes are published through `onFramesChanged`,
 * which the bridge serializes into a `frame_snapshot` message.
 */

import type { FrameSnapshotReason } from '../types/messages.js'
import {
	applyFrameEvent,
	applyFrameTreeSnapshot,
	dropSessionFrames,
	serializeFrameTable,
	type CdpFrameTreeNode,
	type FrameRecord,
} from './frame-table.js'
import { readTabCookies, type CookieQuery, type NativeCookie } from './tab-cookies.js'

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
export type FramesChangedHandler = (tabId: number, reason: FrameSnapshotReason) => void

/** Full frame table published to the watcher. */
export type FrameSnapshotPayload = {
	topFrameId: string | null
	frames: FrameRecord[]
}

export class DebuggerManager {
	private attached = new Map<number, AttachedTarget>()
	private eventHandlers = new Set<CdpEventHandler>()
	private detachHandlers = new Set<DebuggerDetachHandler>()
	private framesChangedHandlers = new Set<FramesChangedHandler>()
	private frameTreeSyncTimers = new Map<string, ReturnType<typeof setTimeout>>()
	/** Last published frame table per tab; publishes that change nothing are suppressed. */
	private lastPublishedFrames = new Map<number, string>()

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

	/** Subscribe to authoritative frame-table changes (deduplicated; see class doc). */
	onFramesChanged(handler: FramesChangedHandler): () => void {
		this.framesChangedHandlers.add(handler)
		return () => {
			this.framesChangedHandlers.delete(handler)
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
		// The initial table travels inside tab_attached; prime the publish cache so the
		// first post-attach resync only publishes when something actually changed.
		this.lastPublishedFrames.set(tabId, serializeFrameTable(target))
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
		this.lastPublishedFrames.delete(tabId)
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

	/** Current authoritative frame table for a tab, in `frame_snapshot` payload shape. */
	getFrameSnapshot(tabId: number): FrameSnapshotPayload {
		return {
			topFrameId: this.attached.get(tabId)?.topFrameId ?? null,
			frames: this.getFrames(tabId),
		}
	}

	/**
	 * Re-read `Page.getFrameTree` for the root and every child session, then return the
	 * fresh table. Serves `frame_snapshot_request { refresh: true }` (bootstrap and target
	 * recovery on the watcher side). Marks the result as published — the caller ships it
	 * as the request's reply, so no push should follow for the same state.
	 */
	async resyncFrames(tabId: number): Promise<FrameSnapshotPayload> {
		const target = this.getRequiredTarget(tabId)
		await this.refreshFrameTree(tabId, null)
		for (const sessionId of target.childSessions.keys()) {
			try {
				await this.refreshFrameTree(tabId, sessionId)
			} catch {
				// A child session can die mid-resync (iframe removed); its frames are pruned on detach.
			}
		}
		this.lastPublishedFrames.set(tabId, serializeFrameTable(target))
		return this.getFrameSnapshot(tabId)
	}

	/** Read cookies from the attached tab's cookie store (see tab-cookies.ts). */
	async getCookies(tabId: number, query: CookieQuery = {}): Promise<NativeCookie[]> {
		this.getRequiredTarget(tabId)
		return readTabCookies(tabId, query)
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
			this.emitFramesChangedIfNeeded(tabId, 'child_attached')
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
		const target = this.attached.get(tabId)
		if (!target) {
			return
		}
		applyFrameTreeSnapshot(target, sessionId, result.frameTree)
	}

	private updateStateFromEvent(tabId: number, sessionId: string | null, method: string, params?: object): void {
		const target = this.attached.get(tabId)
		if (!target) {
			return
		}

		if (applyFrameEvent(target, sessionId, method, params)) {
			// The real event is re-emitted right after this and the watcher applies it too,
			// so the resulting table is state the watcher already knows: fold it into the
			// publish cache so the next snapshot publish diffs against what the watcher has.
			this.lastPublishedFrames.set(tabId, serializeFrameTable(target))
		}
	}

	/** Publish the tab's frame table through onFramesChanged, unless it matches the last publish. */
	private emitFramesChangedIfNeeded(tabId: number, reason: FrameSnapshotReason): void {
		const target = this.attached.get(tabId)
		if (!target) {
			return
		}

		const serialized = serializeFrameTable(target)
		if (this.lastPublishedFrames.get(tabId) === serialized) {
			return
		}

		this.lastPublishedFrames.set(tabId, serialized)
		for (const handler of this.framesChangedHandlers) {
			handler(tabId, reason)
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
			void this.refreshFrameTree(tabId, sessionId)
				.then(() => {
					this.emitFramesChangedIfNeeded(tabId, 'navigation_resync')
				})
				.catch((error) => {
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
		this.lastPublishedFrames.delete(tabId)
		this.emitDetach(tabId, reason)
	}

	private dropChildSession(tabId: number, sessionId: string): void {
		const target = this.attached.get(tabId)
		if (!target) {
			return
		}

		target.childSessions.delete(sessionId)
		if (dropSessionFrames(target, sessionId)) {
			this.emitFramesChangedIfNeeded(tabId, 'child_detached')
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
