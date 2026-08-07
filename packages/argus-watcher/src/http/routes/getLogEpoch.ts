import type { LogEpochResponse } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'

export const route = defineJsonRoute<undefined, LogEpochResponse>({
	method: 'GET',
	path: '/logs/epoch',
	handle: ({ ctx }) => ({ ok: true, epoch: ctx.buffer.beginLogEpoch() }),
})
