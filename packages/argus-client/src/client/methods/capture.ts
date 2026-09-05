import type {
	RecordResponse,
	RecordStartResponse,
	RecordStatusResponse,
	RecordStopResponse,
	ScreenshotResponse,
	TraceStartResponse,
	TraceStopResponse,
} from '@vforsh/argus-core'
import type {
	RecordCaptureOptions,
	RecordOptions,
	RecordStartResult,
	RecordStatusResult,
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
import { requestWatcherData } from '../watcherRequest.js'

/** Capture methods: screenshots, video recording, Chrome traces. All write to disk on the watcher host. */
export const createCaptureMethods = (ctx: ClientContext) => ({
	screenshot: async (watcherId: string, options: ScreenshotOptions = {}): Promise<ScreenshotResult> => {
		return await requestWatcherData<ScreenshotResponse>(ctx, watcherId, {
			path: '/screenshot',
			timeoutMs: SCREENSHOT_TIMEOUT_MS,
			method: 'POST',
			body: options,
		})
	},

	record: async (watcherId: string, options: RecordCaptureOptions): Promise<RecordStopResult> => {
		const budgetMs = assertRecordBounds(options)
		assertSingleRecordTarget(options)

		// The watcher holds the request open for the whole capture, then encodes.
		return await requestWatcherData<RecordResponse>(ctx, watcherId, {
			path: '/record',
			timeoutMs: budgetMs + RECORD_TIMEOUT_MS,
			method: 'POST',
			body: options,
		})
	},

	recordStart: async (watcherId: string, options: RecordOptions = {}): Promise<RecordStartResult> => {
		assertSingleRecordTarget(options)

		return await requestWatcherData<RecordStartResponse>(ctx, watcherId, {
			path: '/record/start',
			timeoutMs: RECORD_TIMEOUT_MS,
			method: 'POST',
			body: options,
		})
	},

	recordStop: async (watcherId: string, options: RecordStopOptions = {}): Promise<RecordStopResult> => {
		return await requestWatcherData<RecordStopResponse>(ctx, watcherId, {
			path: '/record/stop',
			timeoutMs: RECORD_TIMEOUT_MS,
			method: 'POST',
			body: options,
		})
	},

	recordStatus: async (watcherId: string): Promise<RecordStatusResult> => {
		return await requestWatcherData<RecordStatusResponse>(ctx, watcherId, {
			path: '/record/status',
			timeoutMs: RECORD_TIMEOUT_MS,
			method: 'GET',
		})
	},

	traceStart: async (watcherId: string, options: TraceStartOptions = {}): Promise<TraceStartResult> => {
		return await requestWatcherData<TraceStartResponse>(ctx, watcherId, {
			path: '/trace/start',
			timeoutMs: TRACE_START_TIMEOUT_MS,
			method: 'POST',
			body: options,
		})
	},

	traceStop: async (watcherId: string, options: TraceStopOptions = {}): Promise<TraceStopResult> => {
		return await requestWatcherData<TraceStopResponse>(ctx, watcherId, {
			path: '/trace/stop',
			timeoutMs: TRACE_STOP_TIMEOUT_MS,
			method: 'POST',
			body: options,
		})
	},
})

/**
 * Check that the capture is actually bounded, and report how long it may run.
 *
 * A `durationMs` capture ends on its own clock; an `until` capture ends on a page predicate that
 * may never become true, so it is bounded only by `maxDurationMs`. Either way the caller's request
 * timeout has to out-wait the watcher's, or the recording outlives the call that started it.
 */
const assertRecordBounds = (options: RecordCaptureOptions): number => {
	if (options.durationMs != null && options.until != null) {
		throw new Error('durationMs and until are mutually exclusive')
	}
	if (options.until != null) {
		if (!Number.isFinite(options.maxDurationMs) || (options.maxDurationMs ?? 0) <= 0) {
			throw new Error('maxDurationMs must be greater than 0 when until is supplied')
		}
		return options.maxDurationMs as number
	}
	if (!Number.isFinite(options.durationMs) || (options.durationMs ?? 0) <= 0) {
		throw new Error('durationMs must be greater than 0, or until must name an expression')
	}
	return options.durationMs as number
}

/** The watcher rejects both crop modes at once; fail client-side so the message is immediate. */
const assertSingleRecordTarget = (options: RecordOptions): void => {
	if (options.selector && options.clip) {
		throw new Error('selector and clip are mutually exclusive')
	}
}
