import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { CdpEventHandler, CdpSessionHandle } from '../packages/argus-watcher/src/cdp/connection.js'
import { createRecorder } from '../packages/argus-watcher/src/cdp/recording.js'
import {
	inferRecordFormatFromOutFile,
	parseRecordClipValue,
	parseRecordFormatValue,
	parseRecordFpsValue,
	validateRecordOutFile,
	validateRecordOutFileForFormat,
} from '../packages/argus/src/commands/record.js'

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

	test('validates recording formats and output extensions', () => {
		expect(parseRecordFormatValue('MP4').value).toBe('mp4')
		expect(parseRecordFormatValue('webm').value).toBe('webm')
		expect(parseRecordFormatValue('gif').error).toContain('mp4, webm')
		expect(inferRecordFormatFromOutFile('/tmp/demo.MP4')).toBe('mp4')
		expect(inferRecordFormatFromOutFile('/tmp/demo.webm')).toBe('webm')
		expect(validateRecordOutFile('/tmp/demo.webm')).toBeNull()
		expect(validateRecordOutFile('/tmp/demo.mp4')).toBeNull()
		expect(validateRecordOutFile('/tmp/demo')).toBeNull()
		expect(validateRecordOutFile('/tmp/demo.gif')).toContain('.mp4 or .webm')
		expect(validateRecordOutFileForFormat('/tmp/demo.webm', 'mp4')).toContain('does not match')
	})
})

const ffmpegCommand = process.env.ARGUS_FFMPEG?.trim() || 'ffmpeg'
const hasFfmpeg = spawnSync(ffmpegCommand, ['-version']).status === 0
const hasFfmpegEncoder = (encoder: string): boolean => {
	if (!hasFfmpeg) {
		return false
	}

	const result = spawnSync(ffmpegCommand, ['-hide_banner', '-encoders'], { encoding: 'utf8' })
	return result.status === 0 && `${result.stdout}\n${result.stderr}`.includes(encoder)
}
const testWithMp4 = hasFfmpegEncoder('libx264') ? test : test.skip
const testWithWebm = hasFfmpegEncoder('libvpx') ? test : test.skip

describe('recorder', () => {
	let tempDirs: string[] = []

	afterEach(async () => {
		for (const dir of tempDirs) {
			await fs.rm(dir, { recursive: true, force: true })
		}
		tempDirs = []
	})

	testWithMp4('records fake screencast frames to MP4 by default', async () => {
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
			outFile: 'clip.mp4',
			clip: { x: 0, y: 0, width: 4, height: 4 },
			fps: 5,
		})
		expect(started.format).toBe('mp4')
		expect(started.clipped).toBe(true)

		await new Promise((resolve) => setTimeout(resolve, 250))
		const stopped = await recorder.stop({})
		const stat = await fs.stat(path.join(tempDir, 'clip.mp4'))

		expect(stopped.format).toBe('mp4')
		expect(stopped.frameCount).toBeGreaterThan(0)
		expect(stat.size).toBeGreaterThan(0)
		expect(recordingStates).toEqual([true, false])
		expect(session.calls).toContain('Page.startScreencast')
		expect(session.calls).toContain('Page.screencastFrameAck')
		expect(session.calls).toContain('Page.stopScreencast')
	})

	testWithWebm('records fake screencast frames to WebM when requested', async () => {
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
		expect(started.format).toBe('webm')
		expect(started.clipped).toBe(true)

		await new Promise((resolve) => setTimeout(resolve, 250))
		const stopped = await recorder.stop({})
		const stat = await fs.stat(path.join(tempDir, 'clip.webm'))

		expect(stopped.format).toBe('webm')
		expect(stopped.frameCount).toBeGreaterThan(0)
		expect(stat.size).toBeGreaterThan(0)
		expect(recordingStates).toEqual([true, false])
		expect(session.calls).toContain('Page.startScreencast')
		expect(session.calls).toContain('Page.screencastFrameAck')
		expect(session.calls).toContain('Page.stopScreencast')
	})
})
