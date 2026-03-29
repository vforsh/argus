import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import type { CdpSessionHandle, CdpTargetContext } from '../src/cdp/connection.js'
import { createScreenshotter } from '../src/cdp/screenshot.js'

describe('screenshotter', () => {
	it('captures only the iframe viewport through the top-level page session', async () => {
		const calls: string[] = []
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-screenshot-'))
		const iframeSession = createSessionStub({
			targetContext: { kind: 'frame', frameId: 'frame-1', executionContextId: 1, sessionId: 'session-1' },
			sendAndWait: async (method) => {
				calls.push(`iframe:${method}`)
				throw new Error(`Unexpected iframe CDP method: ${method}`)
			},
		})
		const pageSession = createSessionStub({
			targetContext: { kind: 'page' },
			sendAndWait: async (method, params) => {
				calls.push(`page:${method}`)
				if (method === 'DOM.getFrameOwner') {
					expect(params).toEqual({ frameId: 'frame-1' })
					return { backendNodeId: 42 }
				}
				if (method === 'DOM.getBoxModel') {
					expect(params).toEqual({ backendNodeId: 42 })
					return {
						model: {
							content: [10, 20, 210, 20, 210, 120, 10, 120],
						},
					}
				}
				if (method === 'Page.getLayoutMetrics') {
					return { visualViewport: { pageX: 0, pageY: 0, scale: 1 } }
				}
				if (method === 'Page.captureScreenshot') {
					expect(params).toEqual({
						format: 'png',
						clip: { x: 10, y: 20, width: 200, height: 100, scale: 1 },
					})
					return { data: Buffer.from('png').toString('base64') }
				}
				throw new Error(`Unexpected page CDP method: ${method}`)
			},
		})

		try {
			const screenshotter = createScreenshotter({
				session: iframeSession,
				pageSession,
				artifactsDir,
			})

			await screenshotter.capture({ outFile: path.join(artifactsDir, 'frame.png'), format: 'png' })

			expect(calls).toEqual(['page:DOM.getFrameOwner', 'page:DOM.getBoxModel', 'page:Page.getLayoutMetrics', 'page:Page.captureScreenshot'])
		} finally {
			await fs.rm(artifactsDir, { recursive: true, force: true })
		}
	})

	it('captures a selector inside an iframe by translating frame-relative coordinates', async () => {
		const calls: string[] = []
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-screenshot-'))
		const iframeSession = createSessionStub({
			targetContext: { kind: 'frame', frameId: 'frame-1', executionContextId: 7, sessionId: 'session-1' },
			sendAndWait: async (method, params) => {
				calls.push(`iframe:${method}`)
				if (method === 'DOM.enable') {
					return {}
				}
				if (method === 'DOM.getDocument') {
					expect(params).toEqual({ depth: 1 })
					return { root: { nodeId: 1 } }
				}
				if (method === 'DOM.querySelectorAll') {
					expect(params).toEqual({ nodeId: 1, selector: '#cta' })
					return { nodeIds: [2] }
				}
				if (method === 'DOM.getBoxModel') {
					expect(params).toEqual({ nodeId: 2 })
					return {
						model: {
							content: [5, 6, 55, 6, 55, 26, 5, 26],
						},
					}
				}
				if (method === 'Page.getLayoutMetrics') {
					return { visualViewport: { pageX: 0, pageY: 0, scale: 1 } }
				}
				throw new Error(`Unexpected iframe CDP method: ${method}`)
			},
		})
		const pageSession = createSessionStub({
			targetContext: { kind: 'page' },
			sendAndWait: async (method, params) => {
				calls.push(`page:${method}`)
				if (method === 'DOM.getFrameOwner') {
					return { backendNodeId: 42 }
				}
				if (method === 'DOM.getBoxModel') {
					expect(params).toEqual({ backendNodeId: 42 })
					return {
						model: {
							content: [100, 200, 500, 200, 500, 500, 100, 500],
						},
					}
				}
				if (method === 'Page.getLayoutMetrics') {
					return { visualViewport: { pageX: 0, pageY: 0, scale: 1 } }
				}
				if (method === 'Page.captureScreenshot') {
					expect(params).toEqual({
						format: 'png',
						clip: { x: 105, y: 206, width: 50, height: 20, scale: 1 },
					})
					return { data: Buffer.from('png').toString('base64') }
				}
				throw new Error(`Unexpected page CDP method: ${method}`)
			},
		})

		try {
			const screenshotter = createScreenshotter({
				session: iframeSession,
				pageSession,
				artifactsDir,
			})

			await screenshotter.capture({ outFile: path.join(artifactsDir, 'frame-selector.png'), format: 'png', selector: '#cta' })

			expect(calls).toEqual([
				'page:DOM.getFrameOwner',
				'page:DOM.getBoxModel',
				'page:Page.getLayoutMetrics',
				'iframe:DOM.enable',
				'iframe:DOM.getDocument',
				'iframe:DOM.querySelectorAll',
				'iframe:DOM.getBoxModel',
				'iframe:Page.getLayoutMetrics',
				'page:Page.captureScreenshot',
			])
		} finally {
			await fs.rm(artifactsDir, { recursive: true, force: true })
		}
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
