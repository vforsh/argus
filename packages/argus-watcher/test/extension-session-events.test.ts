import { describe, expect, it } from 'bun:test'
import type { CdpEventHandler, CdpEventMeta, CdpSessionHandle } from '../src/cdp/connection.js'
import { createEmptyFrameState } from '../src/sources/extension-frame-state.js'
import { registerExtensionSessionEventHandlers } from '../src/sources/extension-session-events.js'

describe('extension session events', () => {
	it('preserves a known child session id when root-session frame navigation refreshes metadata', () => {
		const state = createEmptyFrameState()
		state.frames.set('child-frame', {
			frameId: 'child-frame',
			parentFrameId: 'root-frame',
			url: 'https://old.example/frame',
			title: 'Old Frame',
			sessionId: 'child-session',
		})

		const stub = createSessionStub()
		registerExtensionSessionEventHandlers({
			session: {
				tabId: 1,
				url: 'https://vk.com/app54508014',
				title: 'vk app',
				attachedAt: 1,
				topFrameId: 'root-frame',
				frames: [],
				handle: stub.session,
				enabledDomains: new Set(),
			},
			events: {
				onLog: () => {},
				onStatus: () => {},
			},
			getOrCreateFrameState: () => state,
			reconcileTargetSelection: () => false,
			removeFrame: () => {},
			refreshFrameTitle: async () => {},
			emitTargetChanged: () => {},
			setCurrentSession: () => {},
		})

		stub.emit(
			'Page.frameNavigated',
			{
				frame: {
					id: 'child-frame',
					parentId: 'root-frame',
					url: 'https://new.example/frame',
					name: 'New Frame',
				},
			},
			{ sessionId: null },
		)

		expect(state.frames.get('child-frame')).toEqual({
			frameId: 'child-frame',
			parentFrameId: 'root-frame',
			url: 'https://new.example/frame',
			title: 'New Frame',
			sessionId: 'child-session',
		})
	})
})

const createSessionStub = () => {
	const handlers = new Map<string, Set<CdpEventHandler>>()

	const session: CdpSessionHandle = {
		isAttached: () => true,
		sendAndWait: async () => undefined,
		onEvent: (method, handler) => {
			let bucket = handlers.get(method)
			if (!bucket) {
				bucket = new Set()
				handlers.set(method, bucket)
			}
			bucket.add(handler)
			return () => {
				bucket?.delete(handler)
			}
		},
	}

	return {
		session,
		emit: (method: string, params: unknown, meta: CdpEventMeta = { sessionId: null }) => {
			for (const handler of handlers.get(method) ?? []) {
				handler(params, meta)
			}
		},
	}
}
