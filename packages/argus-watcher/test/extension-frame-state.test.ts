import { describe, expect, it } from 'bun:test'
import {
	collectFrameTree,
	createEmptyFrameState,
	createRequestedFrameHint,
	type ExtensionFrame,
	parseExtensionTargetId,
	resolveRequestedFrameId,
	resolveRequestedTarget,
} from '../src/sources/extension-frame-state.js'
import { getSelectedExtensionTarget } from '../src/sources/extension-frame-runtime.js'

describe('extension-frame-state', () => {
	it('keeps iframe selection pending until the frame is discovered', () => {
		const state = createEmptyFrameState()
		expect(resolveRequestedFrameId(state, 'frame-pending', null)).toBeNull()

		state.frames.set('frame-pending', createFrame({ frameId: 'frame-pending', url: 'https://example.com/frame' }))

		expect(resolveRequestedFrameId(state, 'frame-pending', null)).toBe('frame-pending')
	})

	it('prefers the exact iframe url over normalized fallback matches', () => {
		const state = createEmptyFrameState()
		const selectedFrame = createFrame({ frameId: 'frame-a', url: 'https://example.com/embed?id=1', title: 'Embed' })
		const requestedFrameHint = createRequestedFrameHint(selectedFrame)

		state.frames.set('frame-b', createFrame({ frameId: 'frame-b', url: 'https://example.com/embed?id=2', title: 'Embed' }))

		state.frames.set('frame-c', createFrame({ frameId: 'frame-c', url: selectedFrame.url, title: 'Embed' }))

		expect(resolveRequestedFrameId(state, selectedFrame.frameId, requestedFrameHint)).toBe('frame-c')
	})

	it('rematches a reloaded iframe when only the query string changes and the fallback is unique', () => {
		const state = createEmptyFrameState()
		const selectedFrame = createFrame({ frameId: 'frame-a', url: 'https://example.com/embed?id=1&token=old', title: 'Embed' })
		const requestedFrameHint = createRequestedFrameHint(selectedFrame)

		state.frames.set('frame-b', createFrame({ frameId: 'frame-b', url: 'https://example.com/embed?id=2&token=new', title: 'Embed' }))

		state.frames.set('frame-c', createFrame({ frameId: 'frame-c', url: 'https://example.com/embed?id=99&token=fresh', title: 'Embed' }))

		expect(resolveRequestedFrameId(state, selectedFrame.frameId, requestedFrameHint)).toBeNull()

		state.frames.delete('frame-b')
		expect(resolveRequestedFrameId(state, selectedFrame.frameId, requestedFrameHint)).toBe('frame-c')
	})

	it('falls back to title matching only when the selected iframe had no url', () => {
		const state = createEmptyFrameState()
		const requestedFrameHint = createRequestedFrameHint(createFrame({ frameId: 'frame-selected', url: '', title: 'Untitled Preview' }))

		state.frames.set('frame-preview', createFrame({ frameId: 'frame-preview', url: '', title: 'Untitled Preview' }))

		expect(resolveRequestedFrameId(state, 'missing-frame', requestedFrameHint)).toBe('frame-preview')
	})

	it('falls back to the page only after an active iframe detaches', () => {
		const state = createEmptyFrameState()
		state.requestedFrameId = 'frame-selected'

		expect(resolveRequestedTarget(state)).toEqual({ kind: 'pending' })

		state.requestedFrameDetached = true
		expect(resolveRequestedTarget(state)).toEqual({ kind: 'page' })
	})

	it('parses virtual extension target ids', () => {
		expect(parseExtensionTargetId('tab:42')).toEqual({ tabId: 42, frameId: null })
		expect(parseExtensionTargetId('frame:42:child:frame')).toEqual({ tabId: 42, frameId: 'child:frame' })
		expect(parseExtensionTargetId('42')).toEqual({ tabId: 42, frameId: null })
	})

	it('preserves known session ownership when a frame tree refresh updates metadata', () => {
		const state = createEmptyFrameState()
		state.frames.set(
			'child-frame',
			createFrame({ frameId: 'child-frame', parentFrameId: 'root-frame', url: 'https://old.example/frame', sessionId: 'child-session' }),
		)

		collectFrameTree(
			{
				frame: { id: 'root-frame', url: 'https://root.example/' },
				childFrames: [
					{
						frame: { id: 'child-frame', parentId: 'root-frame', url: 'https://new.example/frame', name: 'Nested Frame' },
					},
				],
			},
			state,
		)

		expect(state.topFrameId).toBe('root-frame')
		expect(state.frames.get('child-frame')).toEqual({
			frameId: 'child-frame',
			parentFrameId: 'root-frame',
			url: 'https://new.example/frame',
			title: 'Nested Frame',
			sessionId: 'child-session',
		})
	})

	it('keeps reporting the selected iframe while frame metadata is temporarily missing', () => {
		const state = createEmptyFrameState()
		state.activeFrameId = 'frame-active'
		state.requestedFrameHint = createRequestedFrameHint(
			createFrame({ frameId: 'frame-active', url: 'https://game.example/frame', title: 'Game Frame' }),
		)

		const target = getSelectedExtensionTarget(
			{
				tabId: 42,
				url: 'https://vk.com/app54508014',
				title: 'parent-page',
				faviconUrl: 'https://vk.com/favicon.ico',
				attachedAt: 1,
				topFrameId: 'root-frame',
				frames: [],
				handle: {
					isAttached: () => true,
					sendAndWait: async () => undefined,
					onEvent: () => () => {},
				},
				enabledDomains: new Set(),
			},
			state,
		)

		expect(target).toEqual({
			id: 'frame:42:frame-active',
			title: 'Game Frame',
			url: 'https://game.example/frame',
			type: 'iframe',
			parentId: 'tab:42',
			faviconUrl: 'https://vk.com/favicon.ico',
			attached: true,
		})
	})
})

const createFrame = (overrides: Partial<ExtensionFrame> & Pick<ExtensionFrame, 'frameId'>): ExtensionFrame => ({
	frameId: overrides.frameId,
	parentFrameId: overrides.parentFrameId ?? 'root',
	url: overrides.url ?? '',
	title: overrides.title ?? null,
	sessionId: overrides.sessionId ?? null,
})
