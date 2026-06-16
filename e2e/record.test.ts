import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { CdpEventHandler, CdpSessionHandle } from '../packages/argus-watcher/src/cdp/connection.js'
import { createRecorder } from '../packages/argus-watcher/src/cdp/recording.js'
import { parseRecordClipValue, parseRecordFpsValue, validateRecordOutFile } from '../packages/argus/src/commands/record.js'

const PNG_8X8 =
	'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAhklEQVR4nBXOQREAQQjEwJWCFKQgBSmIGAFIwclc7tlVeeS9J8eT88n15MaDFx9+L+QIOUOukBsPXnzxBylHyplypdx48OLLPyg5Ss6Sq+TGgxdf/UHz0Dw0D80DHrz4+g+Gh+FheBge8ODFN3+wPCwPy8PygAcvvv2D4+F4OB6OBzx48eEPqHqkwUku9gIAAAAASUVORK5CYII='

class FakeCdpSession implements CdpSessionHandle {
	readonly calls: string[] = []
	private readonly handlers = new Map<string, Set<CdpEventHandler>>()

	isAttached(): boolean {
		return true
	}

	async sendAndWait(method: string): Promise<unknown> {
		this.calls.push(method)
		if (method === 'Page.getLayoutMetrics') {
			return {
				cssVisualViewport: {
					pageX: 0,
					pageY: 0,
					scale: 1,
					clientWidth: 8,
					clientHeight: 8,
				},
			}
		}
		if (method === 'Page.startScreencast') {
			queueMicrotask(() => {
				this.emit('Page.screencastFrame', { data: PNG_8X8, sessionId: 1 })
			})
		}
		return {}
	}

	onEvent(method: string, handler: CdpEventHandler): () => void {
		let bucket = this.handlers.get(method)
		if (!bucket) {
			bucket = new Set()
			this.handlers.set(method, bucket)
		}
		bucket.add(handler)
		return () => bucket?.delete(handler)
	}

	private emit(method: string, params: unknown): void {
		for (const handler of this.handlers.get(method) ?? []) {
			handler(params, { sessionId: null })
		}
	}
}

describe('record command parsing', () => {
	test('parses viewport clip values', () => {
		expect(parseRecordClipValue('1,2,300,200').value).toEqual({ x: 1, y: 2, width: 300, height: 200 })
		expect(parseRecordClipValue('1,2,0,200').error).toContain('width and height')
		expect(parseRecordClipValue('1,2,3').error).toContain('x,y,width,height')
	})

	test('parses fps range', () => {
		expect(parseRecordFpsValue(undefined).value).toBeUndefined()
		expect(parseRecordFpsValue('29.6').value).toBe(30)
		expect(parseRecordFpsValue('0').error).toContain('1 to 60')
		expect(parseRecordFpsValue('61').error).toContain('1 to 60')
	})

	test('rejects non-webm output extensions', () => {
		expect(validateRecordOutFile('/tmp/demo.webm')).toBeNull()
		expect(validateRecordOutFile('/tmp/demo')).toBeNull()
		expect(validateRecordOutFile('/tmp/demo.gif')).toContain('Only WebM')
	})
})

const ffmpegCommand = process.env.ARGUS_FFMPEG?.trim() || 'ffmpeg'
const hasFfmpeg = spawnSync(ffmpegCommand, ['-version']).status === 0
const testWithFfmpeg = hasFfmpeg ? test : test.skip

describe('recorder', () => {
	let tempDirs: string[] = []

	afterEach(async () => {
		for (const dir of tempDirs) {
			await fs.rm(dir, { recursive: true, force: true })
		}
		tempDirs = []
	})

	testWithFfmpeg('records fake screencast frames to WebM', async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-record-test-'))
		tempDirs.push(tempDir)
		const session = new FakeCdpSession()
		const recordingStates: boolean[] = []
		const recorder = createRecorder({
			session,
			artifactsDir: tempDir,
			onRecordingStateChange: (recording) => {
				recordingStates.push(recording)
			},
		})

		const started = await recorder.start({
			outFile: 'clip.webm',
			clip: { x: 0, y: 0, width: 4, height: 4 },
			fps: 5,
		})
		expect(started.clipped).toBe(true)

		await new Promise((resolve) => setTimeout(resolve, 250))
		const stopped = await recorder.stop({})
		const stat = await fs.stat(path.join(tempDir, 'clip.webm'))

		expect(stopped.frameCount).toBeGreaterThan(0)
		expect(stat.size).toBeGreaterThan(0)
		expect(recordingStates).toEqual([true, false])
		expect(session.calls).toContain('Page.startScreencast')
		expect(session.calls).toContain('Page.screencastFrameAck')
		expect(session.calls).toContain('Page.stopScreencast')
	})
})
