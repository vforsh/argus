import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRecorder, createVisualCapturePlan, toPageClip } from '@vforsh/argus-watcher/internal'
import {
	inferRecordFormatFromOutFile,
	parseRecordClipValue,
	parseRecordFormatValue,
	parseRecordFpsValue,
	parseRecordQualityValue,
	recordCaptureTimeoutMs,
	resolveCaptureBounds,
	validateRecordOutFile,
	validateRecordOutFileForFormat,
} from '../../packages/argus/src/commands/record.js'
import { createFakeCdpSession } from '../helpers/fakeCdpSession.js'
import { useTempDirs } from '../helpers/tempDir.js'
import { TIMEOUTS } from '../helpers/timeouts.js'

// The recorder encodes through a real ffmpeg process.
setDefaultTimeout(TIMEOUTS.process)

const makeTempDir = useTempDirs('argus-record-test')

const PNG_8X8 =
	'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAhklEQVR4nBXOQREAQQjEwJWCFKQgBSmIGAFIwclc7tlVeeS9J8eT88n15MaDFx9+L+QIOUOukBsPXnzxBylHyplypdx48OLLPyg5Ss6Sq+TGgxdf/UHz0Dw0D80DHrz4+g+Gh+FheBge8ODFN3+wPCwPy8PygAcvvv2D4+F4OB6OBzx48eEPqHqkwUku9gIAAAAASUVORK5CYII='

/**
 * Screencast-capable session: answers layout metrics and pushes one frame when recording starts.
 * `respond` answers anything else first (e.g. the `until` expression's `Runtime.evaluate`).
 */
const createScreencastSession = (respond?: (method: string) => unknown) =>
	createFakeCdpSession({
		respond: (method, _params, session) => {
			const answer = respond?.(method)
			if (answer !== undefined) {
				return answer
			}
			if (method === 'Page.getLayoutMetrics') {
				return { cssVisualViewport: { pageX: 0, pageY: 0, scale: 1, clientWidth: 8, clientHeight: 8 } }
			}
			if (method === 'Page.startScreencast') {
				queueMicrotask(() => {
					session.emit('Page.screencastFrame', { data: PNG_8X8, sessionId: 1 })
				})
			}
			return undefined
		},
	})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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
		expect(parseRecordFormatValue('GIF').value).toBe('gif')
		expect(parseRecordFormatValue('avi').error).toContain('mp4, webm, gif')
		expect(inferRecordFormatFromOutFile('/tmp/demo.MP4')).toBe('mp4')
		expect(inferRecordFormatFromOutFile('/tmp/demo.webm')).toBe('webm')
		expect(inferRecordFormatFromOutFile('/tmp/demo.gif')).toBe('gif')
		expect(validateRecordOutFile('/tmp/demo.webm')).toBeNull()
		expect(validateRecordOutFile('/tmp/demo.mp4')).toBeNull()
		expect(validateRecordOutFile('/tmp/demo.gif')).toBeNull()
		expect(validateRecordOutFile('/tmp/demo')).toBeNull()
		expect(validateRecordOutFile('/tmp/demo.avi')).toContain('.mp4, .webm or .gif')
		expect(validateRecordOutFileForFormat('/tmp/demo.webm', 'mp4')).toContain('does not match')
	})

	test('parses capture frame quality', () => {
		expect(parseRecordQualityValue(undefined).value).toBeUndefined()
		expect(parseRecordQualityValue('80').value).toBe(80)
		expect(parseRecordQualityValue('0').error).toContain('1 to 100')
		expect(parseRecordQualityValue('101').error).toContain('1 to 100')
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
const testWithWebm = hasFfmpegEncoder('libvpx-vp9') ? test : test.skip
const testWithGif = hasFfmpegEncoder('gif') ? test : test.skip

describe('recorder', () => {
	for (const { title, run, format } of [
		{ title: 'records fake screencast frames to MP4 by default', run: testWithMp4, format: 'mp4' },
		{ title: 'records fake screencast frames to WebM when requested', run: testWithWebm, format: 'webm' },
	] as const) {
		run(title, async () => {
			const tempDir = await makeTempDir()
			const session = createScreencastSession()
			const recordingStates: boolean[] = []
			const recorder = createRecorder({
				session,
				artifactsDir: tempDir,
				onRecordingStateChange: (recording) => {
					recordingStates.push(recording)
				},
			})

			const started = await recorder.start({
				outFile: `clip.${format}`,
				clip: { x: 0, y: 0, width: 4, height: 4 },
				fps: 5,
			})
			expect(started.format).toBe(format)
			expect(started.clipped).toBe(true)

			await sleep(250)
			const stopped = await recorder.stop({})
			const stat = await fs.stat(path.join(tempDir, `clip.${format}`))

			expect(stopped.format).toBe(format)
			expect(stopped.frameCount).toBeGreaterThan(0)
			expect(stat.size).toBeGreaterThan(0)
			expect(recordingStates).toEqual([true, false])
			expect(session.methods).toContain('Page.startScreencast')
			expect(session.methods).toContain('Page.screencastFrameAck')
			expect(session.methods).toContain('Page.stopScreencast')
		})
	}
})

describe('recorder controls', () => {
	testWithGif('encodes GIF output and clamps its frame rate', async () => {
		const tempDir = await makeTempDir()
		const recorder = createRecorder({ session: createScreencastSession(), artifactsDir: tempDir })

		const started = await recorder.start({ outFile: 'clip.gif', fps: 60 })
		expect(started.format).toBe('gif')
		// GIF frame delays are centiseconds, so anything past the cap is wasted bytes.
		expect(started.fps).toBe(20)

		await sleep(150)
		const stopped = await recorder.stop({})

		expect(stopped.format).toBe('gif')
		expect(stopped.sizeBytes).toBeGreaterThan(0)
		expect(stopped.sizeBytes).toBe((await fs.stat(path.join(tempDir, 'clip.gif'))).size)
		expect(stopped.partial).toBe(false)
		expect(stopped.stopReason).toBe('requested')
	})

	testWithMp4('re-arms the screencast when the top frame navigates', async () => {
		const tempDir = await makeTempDir()
		const session = createScreencastSession()
		const recorder = createRecorder({ session, artifactsDir: tempDir })

		await recorder.start({ outFile: 'clip.mp4', fps: 5 })
		const armedAtStart = session.methods.filter((method) => method === 'Page.startScreencast').length

		// A subframe navigation leaves the screencast alone; the top frame kills it.
		session.emit('Page.frameNavigated', { frame: { id: 'child', parentId: 'root', url: 'https://example.test/sub' } })
		expect(session.methods.filter((method) => method === 'Page.startScreencast').length).toBe(armedAtStart)

		session.emit('Page.frameNavigated', { frame: { id: 'root', url: 'https://example.test/next' } })
		await sleep(50)

		const stopped = await recorder.stop({})
		expect(session.methods.filter((method) => method === 'Page.startScreencast').length).toBe(armedAtStart + 1)
		expect(stopped.navigations).toBe(1)
	})

	testWithMp4('brings the page forward before capturing', async () => {
		const tempDir = await makeTempDir()
		const session = createScreencastSession()
		const recorder = createRecorder({ session, artifactsDir: tempDir })

		await recorder.start({ outFile: 'clip.mp4', fps: 5 })
		await recorder.stop({})

		expect(session.methods.indexOf('Page.bringToFront')).toBeGreaterThanOrEqual(0)
		expect(session.methods.indexOf('Page.bringToFront')).toBeLessThan(session.methods.indexOf('Page.startScreencast'))
	})

	testWithMp4('finalizes a playable file when the session detaches mid-capture', async () => {
		const tempDir = await makeTempDir()
		const recordingStates: boolean[] = []
		const recorder = createRecorder({
			session: createScreencastSession(),
			artifactsDir: tempDir,
			onRecordingStateChange: (recording) => recordingStates.push(recording),
		})

		await recorder.start({ outFile: 'clip.mp4', fps: 5 })
		await sleep(150)
		recorder.onDetached('target_closed')
		await sleep(250)

		const stopped = await recorder.stop({})
		expect(stopped.stopReason).toBe('detached')
		expect(stopped.partial).toBe(true)
		// SIGTERM used to lose the moov atom, leaving an unplayable file behind.
		expect(stopped.sizeBytes).toBeGreaterThan(0)
		expect(recordingStates).toEqual([true, false])
	})

	testWithMp4('stops a capture when the until expression turns truthy', async () => {
		const tempDir = await makeTempDir()
		let done = false
		const session = createScreencastSession((method) => (method === 'Runtime.evaluate' ? { result: { value: done } } : undefined))
		const recorder = createRecorder({ session, artifactsDir: tempDir })

		setTimeout(() => {
			done = true
		}, 120)

		const stopped = await recorder.capture({ outFile: 'clip.mp4', fps: 5, until: 'window.done', pollIntervalMs: 20, maxDurationMs: 5_000 })

		expect(stopped.stopReason).toBe('until')
		expect(stopped.durationMs).toBeGreaterThanOrEqual(100)
		expect(stopped.durationMs).toBeLessThan(4_000)
		expect(stopped.sizeBytes).toBeGreaterThan(0)
	})

	testWithMp4('stops an open-ended recording at its max duration', async () => {
		const tempDir = await makeTempDir()
		const recorder = createRecorder({ session: createScreencastSession(), artifactsDir: tempDir })

		const started = await recorder.start({ outFile: 'clip.mp4', fps: 5, maxDurationMs: 150 })
		expect(started.maxDurationMs).toBe(150)

		await sleep(500)
		expect(recorder.status()).toBeNull()

		const stopped = await recorder.stop({})
		expect(stopped.stopReason).toBe('max-duration')
		expect(stopped.durationMs).toBeLessThan(400)
	})

	testWithMp4('reports the active recording through status', async () => {
		const tempDir = await makeTempDir()
		const recorder = createRecorder({ session: createScreencastSession(), artifactsDir: tempDir })

		expect(recorder.status()).toBeNull()
		const started = await recorder.start({ outFile: 'clip.mp4', fps: 5 })

		await sleep(120)
		const active = recorder.status()
		expect(active?.recordId).toBe(started.recordId)
		expect(active?.elapsedMs).toBeGreaterThan(0)
		expect(active?.frameCount).toBeGreaterThan(0)
		expect(active?.maxDurationMs).toBe(started.maxDurationMs)

		await recorder.stop({})
		expect(recorder.status()).toBeNull()
	})

	testWithMp4('refuses to start a second recording while one is active', async () => {
		const tempDir = await makeTempDir()
		const recorder = createRecorder({ session: createScreencastSession(), artifactsDir: tempDir })

		await recorder.start({ outFile: 'clip.mp4', fps: 5 })
		await expect(recorder.start({ outFile: 'other.mp4', fps: 5 })).rejects.toThrow('Recording already active')
		await recorder.stop({})
	})

	testWithMp4('paces frames against the wall clock rather than timer ticks', async () => {
		const tempDir = await makeTempDir()
		const recorder = createRecorder({ session: createScreencastSession(), artifactsDir: tempDir })

		await recorder.start({ outFile: 'clip.mp4', fps: 10 })
		await sleep(400)
		const stopped = await recorder.stop({})

		// The file has to cover the capture window: frames ≈ fps × seconds, not "one per tick".
		const expectedFrames = Math.round((stopped.durationMs / 1000) * stopped.fps)
		expect(stopped.frameCount).toBeGreaterThanOrEqual(expectedFrames - 1)
		expect(stopped.frameCount).toBeLessThanOrEqual(expectedFrames + 1)
	})
})

/**
 * A scrolled page used to put every selector crop outside the captured frame: `DOM.getBoxModel`
 * reports viewport-relative coordinates, and the capture plan subtracted the scroll offset from
 * them a second time. Screenshots came out blank and recordings came out two pixels tall, but only
 * once something had scrolled — which is why it survived so long.
 */
describe('visual capture coordinates', () => {
	const SCROLL_Y = 2120.5
	const ELEMENT_VIEWPORT_Y = 540.9

	const createScrolledSession = () =>
		createFakeCdpSession({
			respond: (method) => {
				if (method === 'Page.getLayoutMetrics') {
					return { cssVisualViewport: { pageX: 0, pageY: SCROLL_Y, scale: 1, clientWidth: 1185, clientHeight: 1284 } }
				}
				if (method === 'DOM.getDocument') {
					return { root: { nodeId: 1 } }
				}
				if (method === 'DOM.querySelectorAll') {
					return { nodeIds: [7] }
				}
				if (method === 'DOM.getBoxModel') {
					// Viewport-relative, exactly as getBoundingClientRect reports it.
					const top = ELEMENT_VIEWPORT_Y
					const bottom = ELEMENT_VIEWPORT_Y + 202.5
					return { model: { content: [41, top, 401, top, 401, bottom, 41, bottom] } }
				}
				return undefined
			},
		})

	test('keeps a selector clip in viewport coordinates on a scrolled page', async () => {
		const plan = await createVisualCapturePlan(createScrolledSession(), undefined, { selector: '#target' })

		expect(plan.clip?.y).toBeCloseTo(ELEMENT_VIEWPORT_Y, 1)
		expect(plan.clip?.height).toBeCloseTo(202.5, 1)
		expect(plan.pageOffset).toEqual({ x: 0, y: SCROLL_Y })
	})

	test('converts to document coordinates only for screenshots', async () => {
		const plan = await createVisualCapturePlan(createScrolledSession(), undefined, { selector: '#target' })
		const pageClip = toPageClip(plan.clip!, plan.pageOffset)

		// Page.captureScreenshot clips against the document, so the scroll offset is added back once.
		expect(pageClip.y).toBeCloseTo(ELEMENT_VIEWPORT_Y + SCROLL_Y, 1)
		expect(pageClip.x).toBeCloseTo(41, 1)
	})
})

describe('recorder shutdown races', () => {
	testWithMp4('two concurrent stops finalize once and agree on the result', async () => {
		const tempDir = await makeTempDir()
		const recorder = createRecorder({ session: createScreencastSession(), artifactsDir: tempDir })

		await recorder.start({ outFile: 'clip.mp4', fps: 5 })
		await sleep(120)

		// The loser of the race must await the same encode, not move the file out from under ffmpeg.
		const [first, second] = await Promise.allSettled([recorder.stop({}), recorder.stop({})])
		const stopped = first.status === 'fulfilled' ? first.value : null
		expect(stopped?.sizeBytes).toBeGreaterThan(0)
		expect(stopped?.sizeBytes).toBe((await fs.stat(path.join(tempDir, 'clip.mp4'))).size)
		// The second call either returns the same finalized recording or reports there is none left.
		if (second.status === 'fulfilled') {
			expect(second.value.recordId).toBe(stopped?.recordId as string)
		} else {
			expect(String(second.reason)).toContain('No active recording')
		}
	})

	testWithMp4('a stop racing the max-duration timer still writes a complete file', async () => {
		const tempDir = await makeTempDir()
		const recorder = createRecorder({ session: createScreencastSession(), artifactsDir: tempDir })

		await recorder.start({ outFile: 'clip.mp4', fps: 5, maxDurationMs: 150 })
		await sleep(150)

		const stopped = await recorder.stop({ outFile: path.join(tempDir, 'final.mp4') })
		expect(stopped.stopReason).toBe('max-duration')
		expect(stopped.outFile).toBe(path.join(tempDir, 'final.mp4'))
		// The move must happen after the encoder closed, or the file is truncated.
		expect(stopped.sizeBytes).toBe((await fs.stat(path.join(tempDir, 'final.mp4'))).size)
		expect(stopped.sizeBytes).toBeGreaterThan(0)
	})
})

/**
 * The client's request timeout and the watcher's own deadline are computed in different places, so
 * nothing but a test keeps them ordered. If the client's timeout ever lands on or below the
 * watcher's, it abandons a recording that is still running and no one collects the file.
 */
describe('record capture bounds', () => {
	const boundsFor = (options: Parameters<typeof resolveCaptureBounds>[0]) => {
		const resolved = resolveCaptureBounds(options)
		expect(resolved.error).toBeUndefined()
		return resolved.value!
	}

	test('the client always out-waits the watcher deadline', () => {
		const cases = [
			{ duration: '5s' },
			{ duration: '10m' },
			{ duration: '5s', max: '2m' },
			{ until: 'window.done', max: '30s' },
			{ until: 'window.done' },
		]

		for (const options of cases) {
			const { maxDurationMs } = boundsFor(options)
			expect(recordCaptureTimeoutMs(maxDurationMs)).toBeGreaterThan(maxDurationMs)
		}
	})

	test('the watcher backstop sits above the requested window, never on it', () => {
		const { durationMs, maxDurationMs } = boundsFor({ duration: '5s' })

		expect(durationMs).toBe(5_000)
		// An equal deadline would race the duration timer and report 'max-duration' at random.
		expect(maxDurationMs).toBeGreaterThan(durationMs as number)
	})

	test('until is bounded by --max, or a default when none is given', () => {
		expect(boundsFor({ until: 'window.done', max: '30s' }).maxDurationMs).toBe(30_000)
		expect(boundsFor({ until: 'window.done' }).maxDurationMs).toBe(60_000)
		expect(boundsFor({ until: 'window.done', poll: '100ms' }).pollIntervalMs).toBe(100)
	})

	test('rejects bounds that contradict each other', () => {
		// Previously Math.max discarded the shorter --max and ran the full --duration in silence.
		expect(resolveCaptureBounds({ duration: '10s', max: '5s' }).error).toContain('shorter than --duration')
		expect(resolveCaptureBounds({ duration: '1s', until: 'x' }).error).toContain('both --duration and --until')
		expect(resolveCaptureBounds({}).error).toContain('Missing --duration')
		expect(resolveCaptureBounds({ duration: 'bogus' }).error).toContain('Invalid --duration')
		expect(resolveCaptureBounds({ duration: '1s', max: 'nope' }).error).toContain('Invalid --max')
	})
})
