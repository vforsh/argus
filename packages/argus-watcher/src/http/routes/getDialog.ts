import type { DialogStatusResponse } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'

export const handle = defineJsonRoute<undefined, DialogStatusResponse>({
	method: 'GET',
	path: '/dialog',
	endpoint: 'dialog/status',
	handle: ({ ctx }) => {
		const response: DialogStatusResponse = {
			ok: true,
			dialog: ctx.getDialog(),
		}
		return response
	},
}).handler
