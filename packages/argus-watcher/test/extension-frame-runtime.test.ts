import { describe, expect, it } from 'bun:test'
import { createEmptyFrameState, type ExtensionFrame } from '../src/sources/extension-frame-state.js'
import { reconcileExtensionTargetSelection, removeExtensionFrame, setRequestedTargetSelection } from '../src/sources/extension-frame-runtime.js'

describe('extension-frame-runtime', () => {
	it('hydrates the requested iframe hint once a pending selection becomes active', () => {
		const state = createEmptyFrameState()
		setRequestedTargetSelection(state, 'frame-selected')

		state.frames.set('frame-selected', createFrame({ frameId: 'frame-selected', url: 'https://game.example/frame', title: 'Game Frame' }))

		const changed = reconcileExtensionTargetSelection(createSessionStub(), state, () => {})

		expect(changed).toBe(true)
		expect(state.activeFrameId).toBe('frame-selected')
		expect(state.requestedFrameId).toBe('frame-selected')
		expect(state.requestedFrameHint).toEqual({
			url: 'https://game.example/frame',
			urlKey: 'https://game.example/frame',
			title: 'Game Frame',
		})
	})

	it('rematches a reloaded iframe after an early selection landed before frame metadata existed', () => {
		const state = createEmptyFrameState()
		setRequestedTargetSelection(state, 'frame-old')

		state.frames.set('frame-old', createFrame({ frameId: 'frame-old', url: 'https://game.example/frame?token=old', title: 'Game Frame' }))
		reconcileExtensionTargetSelection(createSessionStub(), state, () => {})

		removeExtensionFrame(state, 'frame-old')
		expect(state.activeFrameId).toBeNull()
		expect(state.requestedFrameDetached).toBe(true)

		state.frames.set('frame-new', createFrame({ frameId: 'frame-new', url: 'https://game.example/frame?token=fresh', title: 'Game Frame' }))

		const changed = reconcileExtensionTargetSelection(createSessionStub(), state, () => {})

		expect(changed).toBe(true)
		expect(state.activeFrameId).toBe('frame-new')
		expect(state.requestedFrameId).toBe('frame-new')
		expect(state.requestedFrameHint).toEqual({
			url: 'https://game.example/frame?token=fresh',
			urlKey: 'https://game.example/frame',
			title: 'Game Frame',
		})
	})
})

function createSessionStub() {
	return {
		tabId: 1,
		url: 'https://vk.com/app54508014',
		title: 'vk app',
		attachedAt: 1,
		topFrameId: 'root-frame',
		frames: [],
		handle: {
			isAttached: () => true,
			sendAndWait: async () => undefined,
			onEvent: () => () => {},
		},
		enabledDomains: new Set(),
	}
}

function createFrame(overrides: Partial<ExtensionFrame> & Pick<ExtensionFrame, 'frameId'>): ExtensionFrame {
	return {
		frameId: overrides.frameId,
		parentFrameId: overrides.parentFrameId ?? 'root-frame',
		url: overrides.url ?? '',
		title: overrides.title ?? null,
		sessionId: overrides.sessionId ?? null,
	}
}
