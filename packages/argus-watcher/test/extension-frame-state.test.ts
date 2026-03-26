import { describe, expect, it } from 'bun:test'
import { collectFrameTree, createEmptyFrameState, parseExtensionTargetId, resolveRequestedFrameId } from '../src/sources/extension-frame-state.js'

describe('extension-frame-state', () => {
	it('keeps iframe selection pending until the frame is discovered', () => {
		const state = createEmptyFrameState()
		expect(resolveRequestedFrameId(state, 'frame-pending')).toBeNull()

		state.frames.set('frame-pending', {
			frameId: 'frame-pending',
			parentFrameId: 'root',
			url: 'https://example.com/frame',
			title: null,
			sessionId: null,
		})

		expect(resolveRequestedFrameId(state, 'frame-pending')).toBe('frame-pending')
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
