import { describe, expect, it } from 'bun:test'
import type { CdpSessionHandle, CdpTargetContext } from '../src/cdp/connection.js'
import { getDomRootId } from '../src/cdp/dom/selector.js'

describe('dom selector root resolution', () => {
	it('prefers DOM.getDocument for frame targets with a child session', async () => {
		const calls: string[] = []
		const session = createSessionStub({
			targetContext: { kind: 'frame', frameId: 'frame-1', executionContextId: 7, sessionId: 'session-1' },
			sendAndWait: async (method, params) => {
				calls.push(method)
				if (method === 'DOM.getDocument') {
					expect(params).toEqual({ depth: 1 })
					return { root: { nodeId: 123 } }
				}
				throw new Error(`Unexpected CDP method: ${method}`)
			},
		})

		const rootId = await getDomRootId(session)

		expect(rootId).toBe(123)
		expect(calls).toEqual(['DOM.getDocument'])
	})

	it('falls back to Runtime.evaluate when a frame has no child session yet', async () => {
		const calls: string[] = []
		const session = createSessionStub({
			targetContext: { kind: 'frame', frameId: 'frame-1', executionContextId: 7, sessionId: null },
			sendAndWait: async (method, params) => {
				calls.push(method)
				if (method === 'Runtime.evaluate') {
					expect(params).toEqual({
						expression: 'document',
						contextId: 7,
						returnByValue: false,
					})
					return { result: { objectId: 'document-object' } }
				}
				if (method === 'DOM.requestNode') {
					expect(params).toEqual({ objectId: 'document-object' })
					return { nodeId: 321 }
				}
				throw new Error(`Unexpected CDP method: ${method}`)
			},
		})

		const rootId = await getDomRootId(session)

		expect(rootId).toBe(321)
		expect(calls).toEqual(['Runtime.evaluate', 'DOM.requestNode'])
	})
})

const createSessionStub = (options: {
	targetContext: CdpTargetContext
	sendAndWait: (method: string, params?: Record<string, unknown>) => Promise<unknown>
}): CdpSessionHandle => ({
	isAttached: () => true,
	sendAndWait: options.sendAndWait,
	onEvent: () => () => {},
	getTargetContext: () => options.targetContext,
})
