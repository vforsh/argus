import { beforeEach, describe, expect, it } from 'bun:test'

import { DebuggerManager } from '../src/background/debugger-manager.js'

describe('debugger-manager frame snapshots', () => {
	beforeEach(() => {
		installChromeDebuggerMock()
	})

	it('prunes stale root-session frames after a refreshed frame tree', () => {
		const manager = createManager()
		const target = createAttachedTarget({
			frames: [
				frameRecord('root-frame', null, 'https://vk.com/app54508014', null),
				frameRecord('stale-root-frame', 'root-frame', 'https://vk.com/q_frame.html?old=1', null),
				frameRecord('child-session-frame', 'root-frame', 'https://game.example/frame', 'child-session'),
			],
			topFrameId: 'root-frame',
		})
		const detachedFrameIds: string[] = []

		manager.onEvent((_tabId, method, params) => {
			if (method === 'Page.frameDetached') {
				detachedFrameIds.push((params as { frameId?: string }).frameId ?? '')
			}
		})
		;(manager as any).attached.set(1, target)
		;(manager as any).replaceFrameTreeSnapshot(1, null, {
			frame: { id: 'root-frame', url: 'https://vk.com/app54508014' },
			childFrames: [{ frame: { id: 'current-root-frame', parentId: 'root-frame', url: 'https://vk.com/q_frame.html?current=1' } }],
		})

		expect([...target.frames.keys()]).toEqual(['root-frame', 'child-session-frame', 'current-root-frame'])
		expect(detachedFrameIds).toEqual(['stale-root-frame'])
	})

	it('prunes stale child-session frames without touching other sessions', () => {
		const manager = createManager()
		const target = createAttachedTarget({
			frames: [
				frameRecord('root-frame', null, 'https://vk.com/app54508014', null),
				frameRecord('stale-child-frame', 'root-frame', 'https://game.example/old', 'child-session'),
				frameRecord('other-child-frame', 'root-frame', 'https://game.example/other', 'other-session'),
			],
			topFrameId: 'root-frame',
		})
		const detachedFrameIds: string[] = []

		manager.onEvent((_tabId, method, params, meta) => {
			if (method === 'Page.frameDetached' && meta?.sessionId === 'child-session') {
				detachedFrameIds.push((params as { frameId?: string }).frameId ?? '')
			}
		})
		;(manager as any).attached.set(1, target)
		;(manager as any).replaceFrameTreeSnapshot(1, 'child-session', {
			frame: { id: 'current-child-frame', url: 'https://game.example/current' },
		})

		expect([...target.frames.keys()]).toEqual(['root-frame', 'other-child-frame', 'current-child-frame'])
		expect(detachedFrameIds).toEqual(['stale-child-frame'])
	})

	it('refreshes the authoritative snapshot after a top-frame navigation', async () => {
		const manager = createManager()
		const target = createAttachedTarget({
			frames: [frameRecord('root-frame', null, 'https://vk.com/app54508014', null)],
			topFrameId: 'root-frame',
		})
		const refreshCalls: Array<{ tabId: number; sessionId: string | null }> = []

		;(manager as any).attached.set(1, target)
		;(manager as any).refreshFrameTree = async (tabId: number, sessionId: string | null) => {
			refreshCalls.push({ tabId, sessionId })
		}
		;(manager as any).handleCdpEvent({ tabId: 1 }, 'Page.frameNavigated', {
			frame: { id: 'root-frame', parentId: null, url: 'https://vk.com/app54508014?reload=1' },
		})
		;(manager as any).handleCdpEvent({ tabId: 1 }, 'Page.frameNavigated', {
			frame: { id: 'root-frame', parentId: null, url: 'https://vk.com/app54508014?reload=2' },
		})

		await Bun.sleep(200)
		expect(refreshCalls).toEqual([{ tabId: 1, sessionId: null }])
	})

	it('does not refresh the snapshot for ordinary child-frame navigation events', async () => {
		const manager = createManager()
		const target = createAttachedTarget({
			frames: [frameRecord('root-frame', null, 'https://vk.com/app54508014', null)],
			topFrameId: 'root-frame',
		})
		const refreshCalls: Array<{ tabId: number; sessionId: string | null }> = []

		;(manager as any).attached.set(1, target)
		;(manager as any).refreshFrameTree = async (tabId: number, sessionId: string | null) => {
			refreshCalls.push({ tabId, sessionId })
		}
		;(manager as any).handleCdpEvent({ tabId: 1 }, 'Page.frameNavigated', {
			frame: { id: 'child-frame', parentId: 'root-frame', url: 'https://vk.com/q_frame.html?reload=1' },
		})

		await Bun.sleep(200)
		expect(refreshCalls).toEqual([])
	})
})

function createManager(): DebuggerManager {
	return new DebuggerManager()
}

function installChromeDebuggerMock(): void {
	;(globalThis as typeof globalThis & { chrome?: unknown }).chrome = {
		debugger: {
			onEvent: { addListener: () => undefined },
			onDetach: { addListener: () => undefined },
		},
	} as unknown
}

function createAttachedTarget(options: { frames?: FrameRecordLike[]; topFrameId?: string | null }) {
	return {
		tabId: 1,
		debuggeeId: { tabId: 1 },
		url: 'https://vk.com/app54508014',
		title: 'elka2025-vforsh',
		faviconUrl: undefined,
		attachedAt: 1,
		enabledDomains: new Set<string>(),
		childSessions: new Map(),
		frames: new Map((options.frames ?? []).map((frame) => [frame.frameId, frame])),
		topFrameId: options.topFrameId ?? null,
	}
}

type FrameRecordLike = {
	frameId: string
	parentFrameId: string | null
	url: string
	title: string | null
	sessionId: string | null
}

function frameRecord(frameId: string, parentFrameId: string | null, url: string, sessionId: string | null): FrameRecordLike {
	return {
		frameId,
		parentFrameId,
		url,
		title: null,
		sessionId,
	}
}
