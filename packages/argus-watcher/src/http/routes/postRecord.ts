import type {
	RecordClipRegion,
	RecordRequest,
	RecordResponse,
	RecordStartRequest,
	RecordStartResponse,
	RecordStopRequest,
	RecordStopResponse,
} from '@vforsh/argus-core'
import { defineJsonRoute, type WatcherRouteDefinition } from './defineRoute.js'

export const recordRoutes: readonly WatcherRouteDefinition[] = [
	defineJsonRoute<RecordRequest, RecordResponse>({
		method: 'POST',
		path: '/record',
		parseBody: true,
		endpoint: 'record',
		validate: validateRecordRequest,
		handle: ({ ctx, body }) => ctx.recorder.capture(body),
	}),
	defineJsonRoute<RecordStartRequest, RecordStartResponse>({
		method: 'POST',
		path: '/record/start',
		parseBody: true,
		endpoint: 'record/start',
		validate: validateRecordStartRequest,
		handle: ({ ctx, body }) => ctx.recorder.start(body),
	}),
	defineJsonRoute<RecordStopRequest, RecordStopResponse>({
		method: 'POST',
		path: '/record/stop',
		parseBody: true,
		endpoint: 'record/stop',
		validate: validateRecordStopRequest,
		handle: ({ ctx, body }) => ctx.recorder.stop(body),
	}),
]

function validateRecordRequest(payload: RecordRequest): string | null {
	if (!Number.isFinite(payload.durationMs) || payload.durationMs <= 0) {
		return 'durationMs must be greater than 0'
	}
	return validateRecordStartRequest(payload)
}

function validateRecordStartRequest(payload: RecordStartRequest): string | null {
	const targetError = validateRecordTarget(payload)
	if (targetError) {
		return targetError
	}

	if (payload.outFile != null && typeof payload.outFile !== 'string') {
		return 'outFile must be a string'
	}

	if (payload.fps != null && (!Number.isFinite(payload.fps) || payload.fps < 1 || payload.fps > 60)) {
		return 'fps must be between 1 and 60'
	}

	if (payload.format != null && payload.format !== 'webm') {
		return 'format must be webm'
	}

	return null
}

function validateRecordStopRequest(payload: RecordStopRequest): string | null {
	if (payload.recordId != null && (typeof payload.recordId !== 'string' || !payload.recordId.trim())) {
		return 'recordId must be a non-empty string'
	}
	if (payload.outFile != null && typeof payload.outFile !== 'string') {
		return 'outFile must be a string'
	}
	return null
}

function validateRecordTarget(payload: RecordStartRequest): string | null {
	if (payload.selector != null && (typeof payload.selector !== 'string' || !payload.selector.trim())) {
		return 'selector must be a non-empty string'
	}

	if (payload.clip != null) {
		const clipError = validateClip(payload.clip)
		if (clipError) {
			return clipError
		}
	}

	if (payload.selector && payload.clip) {
		return 'selector and clip are mutually exclusive'
	}

	return null
}

const validateClip = (clip: RecordClipRegion): string | null => {
	if (typeof clip !== 'object' || clip == null) {
		return 'clip must be an object with x, y, width, and height'
	}

	if (![clip.x, clip.y, clip.width, clip.height].every(Number.isFinite)) {
		return 'clip.x, clip.y, clip.width, and clip.height must be finite numbers'
	}

	if (clip.width <= 0 || clip.height <= 0) {
		return 'clip.width and clip.height must be greater than 0'
	}

	return null
}
