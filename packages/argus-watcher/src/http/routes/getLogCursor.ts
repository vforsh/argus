import type { LogCursorResponse } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'

export const route = defineJsonRoute<undefined, LogCursorResponse>({
	method: 'GET',
	path: '/logs/cursor',
	handle: ({ ctx }) => ({ ok: true, cursor: ctx.buffer.getCursor() }),
})
