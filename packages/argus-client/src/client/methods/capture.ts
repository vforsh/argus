import type {
	RecordResponse,
	RecordStartResponse,
	RecordStopResponse,
	ScreenshotResponse,
	TraceStartResponse,
	TraceStopResponse,
} from '@vforsh/argus-core'
import type {
	RecordCaptureOptions,
	RecordOptions,
	RecordStartResult,
	RecordStopOptions,
	RecordStopResult,
	ScreenshotOptions,
	ScreenshotResult,
	TraceStartOptions,
	TraceStartResult,
	TraceStopOptions,
	TraceStopResult,
} from '../../types.js'
import type { ClientContext } from '../context.js'
import { RECORD_TIMEOUT_MS, SCREENSHOT_TIMEOUT_MS, TRACE_START_TIMEOUT_MS, TRACE_STOP_TIMEOUT_MS } from '../context.js'
import { requestWatcher } from '../watcherRequest.js'

/** Capture methods: screenshots, video recording, Chrome traces. All write to disk on the watcher host. */
export const createCaptureMethods = (ctx: ClientContext) => ({
	screenshot: async (watcherId: string, options: ScreenshotOptions = {}): Promise<ScreenshotResult> => {
		const { data } = await requestWatcher<ScreenshotResponse>(ctx, watcherId, {
			path: '/screenshot',
			timeoutMs: SCREENSHOT_TIMEOUT_MS,
			method: 'POST',
			body: options,
		})

		return { outFile: data.outFile, clipped: data.clipped }
	},

	record: async (watcherId: string, options: RecordCaptureOptions): Promise<RecordStopResult> => {
		if (!Number.isFinite(options?.durationMs) || options.durationMs <= 0) {
			throw new Error('durationMs must be greater than 0')
		}
		assertSingleRecordTarget(options)

		// The watcher holds the request open for the whole capture, then encodes.
		const { data } = await requestWatcher<RecordResponse>(ctx, watcherId, {
			path: '/record',
			timeoutMs: options.durationMs + RECORD_TIMEOUT_MS,
			method: 'POST',
			body: options,
		})

		return toRecordStopResult(data)
	},

	recordStart: async (watcherId: string, options: RecordOptions = {}): Promise<RecordStartResult> => {
		assertSingleRecordTarget(options)

		const { data } = await requestWatcher<RecordStartResponse>(ctx, watcherId, {
			path: '/record/start',
			timeoutMs: RECORD_TIMEOUT_MS,
			method: 'POST',
			body: options,
		})

		return {
			recordId: data.recordId,
			sessionName: data.sessionName,
			outFile: data.outFile,
			format: data.format,
			fps: data.fps,
			clipped: data.clipped,
		}
	},

	recordStop: async (watcherId: string, options: RecordStopOptions = {}): Promise<RecordStopResult> => {
		const { data } = await requestWatcher<RecordStopResponse>(ctx, watcherId, {
			path: '/record/stop',
			timeoutMs: RECORD_TIMEOUT_MS,
			method: 'POST',
			body: options,
		})

		return toRecordStopResult(data)
	},

	traceStart: async (watcherId: string, options: TraceStartOptions = {}): Promise<TraceStartResult> => {
		const { data } = await requestWatcher<TraceStartResponse>(ctx, watcherId, {
			path: '/trace/start',
			timeoutMs: TRACE_START_TIMEOUT_MS,
			method: 'POST',
			body: options,
		})

		return { traceId: data.traceId, sessionName: data.sessionName, outFile: data.outFile }
	},

	traceStop: async (watcherId: string, options: TraceStopOptions = {}): Promise<TraceStopResult> => {
		const { data } = await requestWatcher<TraceStopResponse>(ctx, watcherId, {
			path: '/trace/stop',
			timeoutMs: TRACE_STOP_TIMEOUT_MS,
			method: 'POST',
			body: options,
		})

		return { sessionName: data.sessionName, outFile: data.outFile, eventCount: data.eventCount, durationMs: data.durationMs }
	},
})

/** The watcher rejects both crop modes at once; fail client-side so the message is immediate. */
const assertSingleRecordTarget = (options: RecordOptions): void => {
	if (options.selector && options.clip) {
		throw new Error('selector and clip are mutually exclusive')
	}
}

const toRecordStopResult = (data: RecordStopResponse): RecordStopResult => ({
	recordId: data.recordId,
	sessionName: data.sessionName,
	outFile: data.outFile,
	format: data.format,
	fps: data.fps,
	clipped: data.clipped,
	frameCount: data.frameCount,
	durationMs: data.durationMs,
})
