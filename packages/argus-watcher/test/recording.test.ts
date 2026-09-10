import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import type { CdpSessionHandle } from '../src/cdp/connection.js'
import { createRecorder } from '../src/cdp/recording.js'
import { subscribeToScreencast, type RecordingState } from '../src/cdp/recordingSession.js'

describe('recorder capture policy', () => {
	it('rejects recording in background mode before touching the session', async () => {
		const calls: string[] = []
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-recording-'))
		const session = createSessionStub(calls)

		try {
			const recorder = createRecorder({ session, artifactsDir, getVisibilityPolicy: () => 'background' })
			const failure = await recorder.start({ format: 'webm' }).catch((error: unknown) => error)

			expect((failure as { code?: string }).code).toBe('not_available')
			expect((failure as Error).message).toContain('headless Chrome')
			expect(calls).toEqual([])
		} finally {
			await fs.rm(artifactsDir, { recursive: true, force: true })
		}
	})

	it('rechecks policy after a foreground raise before starting the screencast', async () => {
		const calls: string[] = []
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-recording-'))
		let policy: 'foreground' | 'background' = 'foreground'
		const session = createSessionStub(calls, async (method) => {
			if (method === 'Page.bringToFront') {
				policy = 'background'
			}
		})

		try {
			const recorder = createRecorder({ session, artifactsDir, getVisibilityPolicy: () => policy })
			const failure = await recorder.start({ format: 'webm' }).catch((error: unknown) => error)

			expect((failure as { code?: string }).code).toBe('not_available')
			expect(calls).toEqual(['Page.bringToFront', 'Page.stopScreencast'])
		} finally {
			await fs.rm(artifactsDir, { recursive: true, force: true })
		}
	})

	it('blocks a navigation re-arm after policy changes to background', async () => {
		const calls: string[] = []
		const eventHandlers = new Map<string, (params: unknown) => void>()
		let policy: 'foreground' | 'background' = 'background'
		let rearmError: unknown
		const session = {
			isAttached: () => true,
			sendAndWait: async (method: string) => {
				calls.push(method)
				return {}
			},
			onEvent: (method: string, handler: (params: unknown) => void) => {
				eventHandlers.set(method, handler)
				return () => eventHandlers.delete(method)
			},
			getTargetContext: () => ({ kind: 'page' }),
			getReadyTargetContext: async () => ({ kind: 'page' }),
		} as unknown as CdpSessionHandle
		const state = {
			session,
			frameCodec: 'jpeg',
			quality: 90,
			getVisibilityPolicy: () => policy,
			state: 'recording',
			navigations: 0,
			onRearmError: (error: unknown) => {
				rearmError = error
			},
		} as unknown as RecordingState

		subscribeToScreencast(state)
		eventHandlers.get('Page.frameNavigated')?.({ frame: {} })
		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(calls).toEqual([])
		expect(state.navigations).toBe(1)
		expect((rearmError as { code?: string }).code).toBe('not_available')
	})
})

const createSessionStub = (calls: string[], afterCommand?: (method: string) => void): CdpSessionHandle => ({
	isAttached: () => true,
	sendAndWait: async (method) => {
		calls.push(method)
		afterCommand?.(method)
		return {}
	},
	onEvent: () => () => {},
	getTargetContext: () => ({ kind: 'page' }),
	getReadyTargetContext: async () => ({ kind: 'page' }),
})
