import type {
	RecordRequest,
	RecordResponse,
	RecordStartRequest,
	RecordStartResponse,
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
]
