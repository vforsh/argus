import type { NetActivityResponse } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'
import { respondNetDisabled } from './netFilters.js'

/** Open-request count for `--settle`. Not reported as an `httpRequested` event: it is polled. */
export const route = defineJsonRoute<undefined, NetActivityResponse>({
	method: 'GET',
	path: '/net/activity',
	handle: ({ res, ctx }) => {
		if (!ctx.getNetActivity) {
			return respondNetDisabled(res)
		}
		return { ok: true, ...ctx.getNetActivity(), now: Date.now() }
	},
})
