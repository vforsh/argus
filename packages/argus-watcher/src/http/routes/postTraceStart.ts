import type { TraceStartRequest, TraceStartResponse } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'

export const route = defineJsonRoute<TraceStartRequest, TraceStartResponse>({
	method: 'POST',
	path: '/trace/start',
	parseBody: true,
	endpoint: 'trace/start',
	handle: ({ ctx, body: payload }) => ctx.traceRecorder.start(payload),
})
