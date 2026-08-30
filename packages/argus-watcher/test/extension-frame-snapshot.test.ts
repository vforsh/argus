import { describe, expect, it } from 'bun:test'

import type { ExtensionFrameSnapshot, ExtensionSession } from '../src/native-messaging/session-manager.js'
import { applyExtensionFrameSnapshot, type ApplyFrameSnapshotDeps } from '../src/sources/extension-frame-snapshot.js'
import { removeExtensionFrame, setRequestedTargetSelection } from '../src/sources/extension-frame-runtime.js'
import {
	createEmptyFrameState,
	createRequestedFrameHint,
	type ExtensionFrame,
	type ExtensionFrameState,
} from '../src/sources/extension-frame-state.js'

describe('applyExtensionFrameSnapshot', () => {
	it('is idempotent: applying the same snapshot twice changes nothing and reconciles each time', () => {
		const { state, session, deps, calls } = createFixture()
		const snapshot = snapshotOf([frame('root', null, 'https://host.test/app'), frame('child', 'root', 'https://game.test/embed')])

		applyExtensionFrameSnapshot(session, state, snapshot, deps)
		const framesAfterFirst = structuredClone([...state.frames.entries()])
		applyExtensionFrameSnapshot(session, state, snapshot, deps)

		expect([...state.frames.entries()]).toEqual(framesAfterFirst)
		expect(state.topFrameId).toBe('root')
		expect(session.url).toBe('https://host.test/app')
		expect(calls.reconciles).toBe(2)
		expect(calls.pageNavigations).toBe(0)
	})

	it('removes frames missing from the snapshot through removeExtensionFrame, clearing their contexts', () => {
		const { state, session, deps } = createFixture()
		applyExtensionFrameSnapshot(
			session,
			state,
			snapshotOf([frame('root', null, 'https://host.test/app'), frame('gone', 'root', 'https://game.test/old')]),
			deps,
		)
		state.executionContexts.set('gone', 7)

		applyExtensionFrameSnapshot(session, state, snapshotOf([frame('root', null, 'https://host.test/app')]), deps)

		expect(state.frames.has('gone')).toBe(false)
		expect(state.executionContexts.has('gone')).toBe(false)
	})

	it('preserves known session ownership and locally resolved titles across snapshots', () => {
		const { state, session, deps } = createFixture()
		state.frames.set('child', {
			frameId: 'child',
			parentFrameId: 'root',
			url: 'https://old.example/frame',
			title: 'Resolved Title',
			sessionId: 'child-session',
		})

		applyExtensionFrameSnapshot(
			session,
			state,
			snapshotOf([
				frame('root', null, 'https://root.example/'),
				{ ...frame('child', 'root', 'https://new.example/frame'), title: null, sessionId: null },
			]),
			deps,
		)

		expect(state.frames.get('child')).toEqual({
			frameId: 'child',
			parentFrameId: 'root',
			url: 'https://new.example/frame',
			title: 'Resolved Title',
			sessionId: 'child-session',
		})
	})

	it('refreshes titles only for new, url-changed, or titleless frames that have execution contexts', () => {
		const { state, session, deps, calls } = createFixture()
		state.frames.set('stable', { frameId: 'stable', parentFrameId: 'root', url: 'https://game.test/embed', title: 'Game', sessionId: null })
		state.executionContexts.set('stable', 11)
		state.executionContexts.set('fresh', 12)

		applyExtensionFrameSnapshot(
			session,
			state,
			snapshotOf([
				frame('root', null, 'https://host.test/app'),
				{ ...frame('stable', 'root', 'https://game.test/embed'), title: 'Game' },
				frame('fresh', 'root', 'https://game.test/new'),
				frame('no-context', 'root', 'https://game.test/late'),
			]),
			deps,
		)

		expect(calls.titleRefreshes).toEqual(['fresh'])
	})

	it('re-resolves a pending selection through the URL hint when the frame id changed', () => {
		const { state, session, deps, calls } = createFixture()
		state.frames.set('old', { frameId: 'old', parentFrameId: 'root', url: 'https://game.test/embed?token=old', title: null, sessionId: null })
		setRequestedTargetSelection(state, 'old')
		removeExtensionFrame(state, 'old')
		expect(state.requestedFrameHint).toEqual(
			createRequestedFrameHint({
				frameId: 'old',
				parentFrameId: 'root',
				url: 'https://game.test/embed?token=old',
				title: null,
				sessionId: null,
			}),
		)

		applyExtensionFrameSnapshot(
			session,
			state,
			snapshotOf([frame('root', null, 'https://host.test/app'), frame('new', 'root', 'https://game.test/embed?token=new')]),
			deps,
		)

		expect(calls.reconciles).toBe(1)
		expect(calls.pageNavigations).toBe(0)
	})
})

const frame = (frameId: string, parentFrameId: string | null, url: string): ExtensionFrame => ({
	frameId,
	parentFrameId,
	url,
	title: null,
	sessionId: null,
})

const snapshotOf = (frames: ExtensionFrame[]): ExtensionFrameSnapshot => ({
	tabId: 1,
	topFrameId: frames[0]?.frameId ?? null,
	frames,
	reason: 'navigation_resync',
})

function createFixture() {
	const state: ExtensionFrameState = createEmptyFrameState()
	const calls = { reconciles: 0, titleRefreshes: [] as string[], targetChanges: 0, pageNavigations: 0 }
	const session = {
		tabId: 1,
		url: 'https://host.test/initial',
		title: 'Host',
		attachedAt: 1,
		topFrameId: null,
		frames: [],
		handle: {
			isAttached: () => true,
			sendAndWait: async () => undefined as never,
			onEvent: () => () => {},
			getTargetContext: () => ({ kind: 'page' as const }),
			getReadyTargetContext: async () => ({ kind: 'page' as const }),
		},
		requestFrameSnapshot: async () => ({ tabId: 1, topFrameId: null, frames: [], reason: 'requested' as const }),
	} as unknown as ExtensionSession
	const deps: ApplyFrameSnapshotDeps = {
		removeFrame: (_tabId, frameId) => removeExtensionFrame(state, frameId),
		refreshFrameTitle: async (_session, frameId) => {
			calls.titleRefreshes.push(frameId)
		},
		reconcileTargetSelection: () => {
			calls.reconciles += 1
			return false
		},
		emitTargetChanged: () => {
			calls.targetChanges += 1
		},
	}
	return { state, session, deps, calls }
}
