import type { TraceStopRequest, TraceStopResponse } from '@vforsh/argus-core'
import { traceStopRequestSchema } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'

export const route = defineJsonRoute<TraceStopRequest, TraceStopResponse>({
	method: 'POST',
	path: '/trace/stop',
	bodySchema: traceStopRequestSchema,
	endpoint: 'trace/stop',
	handle: ({ ctx, body: payload }) => ctx.traceRecorder.stop(payload),
})
