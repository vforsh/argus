import type { DomModifyRequest, DomModifyResponse } from '@vforsh/argus-core'
import { domModifyRequestSchema } from '@vforsh/argus-core'
import { modifyElements } from '../../cdp/dom.js'
import { defineJsonRoute } from './defineRoute.js'
import { respondMultipleMatches } from './domSelectorRoute.js'

export const route = defineJsonRoute<DomModifyRequest, DomModifyResponse>({
	method: 'POST',
	path: '/dom/modify',
	bodySchema: domModifyRequestSchema,
	endpoint: 'dom/modify',
	handle: async ({ res, ctx, body: payload }) => {
		const all = payload.all ?? false
		const { allNodeIds, modifiedCount } = await modifyElements(ctx.cdpSession, { ...payload, all })

		if (!all && allNodeIds.length > 1) {
			return respondMultipleMatches(res, allNodeIds.length, 'modify')
		}

		return { ok: true, matches: allNodeIds.length, modified: modifiedCount }
	},
})
