import type { TraceStopRequest, TraceStopResponse } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'

export const route = defineJsonRoute<TraceStopRequest, TraceStopResponse>({
	method: 'POST',
	path: '/trace/stop',
	parseBody: true,
	endpoint: 'trace/stop',
	handle: ({ ctx, body: payload }) => ctx.traceRecorder.stop(payload),
})
