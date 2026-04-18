import { describe, expect, it } from 'bun:test'
import type { ExtensionSession } from '../src/native-messaging/session-manager.js'
import { createDelegatingSession } from '../src/sources/extension-delegating-session.js'

describe('extension-delegating-session', () => {
	it('awaits prepared frame context before routing a command into a child session', async () => {
		const calls: Array<{ method: string; params?: Record<string, unknown>; options?: { sessionId?: string } }> = []
		const extensionSession = createExtensionSessionStub({
			sendAndWait: async (method, params, options) => {
				calls.push({ method, params, options })
				return { ok: true }
			},
		})

		const { session } = createDelegatingSession({
			getCurrentSession: () => extensionSession,
			requireCurrentSession: () => extensionSession,
			getTargetContext: () => ({
				kind: 'frame',
				frameId: 'stale-frame',
				executionContextId: null,
				sessionId: null,
			}),
			prepareCommand: async ({ targetContext }) => {
				expect(targetContext).toEqual({
					kind: 'frame',
					frameId: 'stale-frame',
					executionContextId: null,
					sessionId: null,
				})

				return {
					targetContext: {
						kind: 'frame',
						frameId: 'fresh-frame',
						executionContextId: null,
						sessionId: 'child-session',
					},
				}
			},
		})

		await session.sendAndWait('Runtime.evaluate', {
			expression: 'document.title',
		})

		expect(calls).toEqual([
			{
				method: 'Runtime.evaluate',
				params: { expression: 'document.title' },
				options: { sessionId: 'child-session' },
			},
		])
	})
})

function createExtensionSessionStub(overrides: { sendAndWait: NonNullable<ExtensionSession['handle']>['sendAndWait'] }): ExtensionSession {
	return {
		tabId: 1,
		url: 'https://example.com',
		title: 'Example',
		attachedAt: 1,
		topFrameId: 'root',
		frames: [],
		handle: {
			isAttached: () => true,
			sendAndWait: overrides.sendAndWait,
			onEvent: () => () => {},
		},
		enabledDomains: new Set(),
	}
}
