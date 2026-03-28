import { describe, expect, it } from 'bun:test'
import {
	collectFrameTree,
	createEmptyFrameState,
	createRequestedFrameHint,
	parseExtensionTargetId,
	resolveRequestedFrameId,
	resolveRequestedTarget,
} from '../src/sources/extension-frame-state.js'

describe('extension-frame-state', () => {
	it('keeps iframe selection pending until the frame is discovered', () => {
		const state = createEmptyFrameState()
		expect(resolveRequestedFrameId(state, 'frame-pending', null)).toBeNull()

		state.frames.set('frame-pending', {
			frameId: 'frame-pending',
			parentFrameId: 'root',
			url: 'https://example.com/frame',
			title: null,
			sessionId: null,
		})

		expect(resolveRequestedFrameId(state, 'frame-pending', null)).toBe('frame-pending')
	})

	it('rematches a reloaded iframe only when the exact stored url returns', () => {
		const state = createEmptyFrameState()
		const selectedFrame = {
			frameId: 'frame-a',
			parentFrameId: 'root',
			url: 'https://example.com/embed?id=1',
			title: 'Embed',
			sessionId: null,
		}
		const requestedFrameHint = createRequestedFrameHint(selectedFrame)

		state.frames.set('frame-b', {
			frameId: 'frame-b',
			parentFrameId: 'root',
			url: 'https://example.com/embed?id=2',
			title: 'Embed',
			sessionId: null,
		})

		expect(resolveRequestedFrameId(state, selectedFrame.frameId, requestedFrameHint)).toBeNull()

		state.frames.set('frame-c', {
			frameId: 'frame-c',
			parentFrameId: 'root',
			url: selectedFrame.url,
			title: 'Embed',
			sessionId: null,
		})

		expect(resolveRequestedFrameId(state, selectedFrame.frameId, requestedFrameHint)).toBe('frame-c')
	})

	it('falls back to title matching only when the selected iframe had no url', () => {
		const state = createEmptyFrameState()
		const requestedFrameHint = {
			url: null,
			title: 'Untitled Preview',
		}

		state.frames.set('frame-preview', {
			frameId: 'frame-preview',
			parentFrameId: 'root',
			url: '',
			title: 'Untitled Preview',
			sessionId: null,
		})

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
		state.frames.set('child-frame', {
			frameId: 'child-frame',
			parentFrameId: 'root-frame',
			url: 'https://old.example/frame',
			title: null,
			sessionId: 'child-session',
		})

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
})
