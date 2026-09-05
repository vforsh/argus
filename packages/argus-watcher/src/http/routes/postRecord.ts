import type {
	RecordRequest,
	RecordResponse,
	RecordStartRequest,
	RecordStartResponse,
	RecordStatusResponse,
	RecordStopRequest,
	RecordStopResponse,
} from '@vforsh/argus-core'
import { recordRequestSchema, recordStartRequestSchema, recordStopRequestSchema } from '@vforsh/argus-core'
import { defineJsonRoute, type WatcherRouteDefinition } from './defineRoute.js'

export const recordRoutes: readonly WatcherRouteDefinition[] = [
	defineJsonRoute<RecordRequest, RecordResponse>({
		method: 'POST',
		path: '/record',
		bodySchema: recordRequestSchema,
		endpoint: 'record',
		handle: ({ ctx, body }) => ctx.recorder.capture(body),
	}),
	defineJsonRoute<RecordStartRequest, RecordStartResponse>({
		method: 'POST',
		path: '/record/start',
		bodySchema: recordStartRequestSchema,
		endpoint: 'record/start',
		handle: ({ ctx, body }) => ctx.recorder.start(body),
	}),
	defineJsonRoute<RecordStopRequest, RecordStopResponse>({
		method: 'POST',
		path: '/record/stop',
		bodySchema: recordStopRequestSchema,
		endpoint: 'record/stop',
		handle: ({ ctx, body }) => ctx.recorder.stop(body),
	}),
	defineJsonRoute<undefined, RecordStatusResponse>({
		method: 'GET',
		path: '/record/status',
		endpoint: 'record/status',
		handle: ({ ctx }) => {
			const active = ctx.recorder.status()
			return { ok: true, recording: active != null, active }
		},
	}),
]
