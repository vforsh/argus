import type { DialogStatusResponse } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'

export const route = defineJsonRoute<undefined, DialogStatusResponse>({
	method: 'GET',
	path: '/dialog',
	endpoint: 'dialog/status',
	handle: ({ ctx }) => ({ ok: true, dialog: ctx.getDialog() }),
})
