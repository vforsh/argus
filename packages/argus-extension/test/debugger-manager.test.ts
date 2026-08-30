import { beforeEach, describe, expect, it } from 'bun:test'

import { DebuggerManager } from '../src/background/debugger-manager.js'
import { serializeFrameTable } from '../src/background/frame-table.js'

/**
 * C2 contract: frame-table changes are published through onFramesChanged (deduplicated),
 * and the manager NEVER fabricates Page.frameNavigated/Page.frameDetached CDP events —
 * onEvent re-emits only what Chrome actually sent.
 */
describe('debugger-manager frame publishing', () => {
	let frameTree: unknown

	beforeEach(() => {
		frameTree = { frameTree: { frame: { id: 'root-frame', url: 'https://vk.com/app' } } }
		installChromeDebuggerMock(() => frameTree)
	})

	it('publishes one frames-changed per snapshot refresh and fabricates no CDP events', async () => {
		const manager = createManager()
		const emittedCdpEvents: string[] = []
		const framesChanged: Array<{ tabId: number; reason: string }> = []
		manager.onEvent((_tabId, method) => emittedCdpEvents.push(method))
		manager.onFramesChanged((tabId, reason) => framesChanged.push({ tabId, reason }))

		attachTarget(manager, 1)
		frameTree = {
			frameTree: {
				frame: { id: 'root-frame', url: 'https://vk.com/app' },
				childFrames: [{ frame: { id: 'iframe-1', parentId: 'root-frame', url: 'https://vk.com/q_frame.html' } }],
			},
		}
		await (manager as any).refreshFrameTree(1, null)
		;(manager as any).emitFramesChangedIfNeeded(1, 'navigation_resync')

		expect(framesChanged).toEqual([{ tabId: 1, reason: 'navigation_resync' }])
		expect(emittedCdpEvents).toEqual([])
		expect([...manager.getFrames(1).map((frame) => frame.frameId)]).toEqual(['root-frame', 'iframe-1'])
	})

	it('suppresses publishes when a resync changes nothing', async () => {
		const manager = createManager()
		const framesChanged: string[] = []
		manager.onFramesChanged((_tabId, reason) => framesChanged.push(reason))

		attachTarget(manager, 1)
		await (manager as any).refreshFrameTree(1, null)
		;(manager as any).emitFramesChangedIfNeeded(1, 'navigation_resync')
		;(manager as any).emitFramesChangedIfNeeded(1, 'navigation_resync')

		// attach() primed the publish cache with this exact table, so nothing is due at all.
		expect(framesChanged).toEqual([])
	})

	it('publishes child_detached when a child session drops, with no synthetic frameDetached', () => {
		const manager = createManager()
		const emittedCdpEvents: string[] = []
		const framesChanged: string[] = []
		manager.onEvent((_tabId, method) => emittedCdpEvents.push(method))
		manager.onFramesChanged((_tabId, reason) => framesChanged.push(reason))

		attachTarget(manager, 1)
		// The child frame arrives the way it does in production: as a real CDP event the
		// watcher also sees, so the publish cache treats it as watcher-known state.
		;(manager as any).handleCdpEvent({ tabId: 1, sessionId: 'child-session' }, 'Page.frameNavigated', {
			frame: { id: 'child-frame', parentId: 'root-frame', url: 'https://game.example/frame' },
		})
		;(manager as any).dropChildSession(1, 'child-session')

		expect(framesChanged).toEqual(['child_detached'])
		// Only the real navigated event above went out — no fabricated Page.frameDetached.
		expect(emittedCdpEvents).toEqual(['Page.frameNavigated'])
		expect(manager.getFrames(1).map((frame) => frame.frameId)).toEqual(['root-frame'])
	})

	it('resyncFrames refreshes root and child sessions and marks the result as published', async () => {
		const manager = createManager()
		const framesChanged: string[] = []
		manager.onFramesChanged((_tabId, reason) => framesChanged.push(reason))

		attachTarget(manager, 1)
		frameTree = {
			frameTree: {
				frame: { id: 'root-frame', url: 'https://vk.com/app?after=1' },
			},
		}
		const snapshot = await manager.resyncFrames(1)

		expect(snapshot.topFrameId).toBe('root-frame')
		expect(snapshot.frames.map((frame) => frame.url)).toEqual(['https://vk.com/app?after=1'])
		// The caller ships the returned snapshot as the request reply; no push may follow for the same state.
		;(manager as any).emitFramesChangedIfNeeded(1, 'navigation_resync')
		expect(framesChanged).toEqual([])
	})

	it('debounces a full-tree refresh after top-frame navigations only', async () => {
		const manager = createManager()
		const refreshCalls: Array<{ tabId: number; sessionId: string | null }> = []
		attachTarget(manager, 1)
		;(manager as any).refreshFrameTree = async (tabId: number, sessionId: string | null) => {
			refreshCalls.push({ tabId, sessionId })
		}
		;(manager as any).handleCdpEvent({ tabId: 1 }, 'Page.frameNavigated', {
			frame: { id: 'root-frame', parentId: null, url: 'https://vk.com/app?reload=1' },
		})
		;(manager as any).handleCdpEvent({ tabId: 1 }, 'Page.frameNavigated', {
			frame: { id: 'root-frame', parentId: null, url: 'https://vk.com/app?reload=2' },
		})
		;(manager as any).handleCdpEvent({ tabId: 1 }, 'Page.frameNavigated', {
			frame: { id: 'child-frame', parentId: 'root-frame', url: 'https://vk.com/q_frame.html' },
		})

		await Bun.sleep(200)
		expect(refreshCalls).toEqual([{ tabId: 1, sessionId: null }])
	})

	it('re-emits real CDP events untouched', () => {
		const manager = createManager()
		const emitted: Array<{ method: string; sessionId: string | null | undefined }> = []
		manager.onEvent((_tabId, method, _params, meta) => emitted.push({ method, sessionId: meta?.sessionId }))

		attachTarget(manager, 1)
		;(manager as any).handleCdpEvent({ tabId: 1 }, 'Page.frameNavigated', {
			frame: { id: 'root-frame', parentId: null, url: 'https://vk.com/app?real=1' },
		})

		expect(emitted).toEqual([{ method: 'Page.frameNavigated', sessionId: null }])
		expect(manager.getTarget(1)?.url).toBe('https://vk.com/app?real=1')
	})
})

function createManager(): DebuggerManager {
	return new DebuggerManager()
}

/** Seed an attached target the way attach() leaves it: table filled and publish cache primed. */
function attachTarget(manager: DebuggerManager, tabId: number): void {
	const target = {
		tabId,
		debuggeeId: { tabId },
		url: 'https://vk.com/app',
		title: 'app',
		faviconUrl: undefined,
		attachedAt: 1,
		enabledDomains: new Set<string>(),
		childSessions: new Map(),
		frames: new Map([
			['root-frame', { frameId: 'root-frame', parentFrameId: null, url: 'https://vk.com/app', title: null, sessionId: null } as const],
		]),
		topFrameId: 'root-frame',
	}
	;(manager as any).attached.set(tabId, target)
	;(manager as any).lastPublishedFrames.set(tabId, serializeFrameTable(target))
}

function installChromeDebuggerMock(getFrameTree: () => unknown): void {
	globalThis.chrome = {
		debugger: {
			onEvent: { addListener: () => undefined },
			onDetach: { addListener: () => undefined },
			sendCommand: async (_debuggee: unknown, method: string) => {
				if (method === 'Page.getFrameTree') {
					return getFrameTree()
				}
				return {}
			},
		},
	} as unknown as typeof chrome
}
