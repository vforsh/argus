import type { DomRemoveRequest, DomRemoveResponse } from '@vforsh/argus-core'
import { removeElements } from '../../cdp/dom.js'
import { defineJsonRoute } from './defineRoute.js'
import { respondMultipleMatches, validateDomTargetBody } from './domSelectorRoute.js'

export const route = defineJsonRoute<DomRemoveRequest, DomRemoveResponse>({
	method: 'POST',
	path: '/dom/remove',
	parseBody: true,
	endpoint: 'dom/remove',
	validate: validateDomTargetBody,
	handle: async ({ res, ctx, body: payload }) => {
		const all = payload.all ?? false
		const { allNodeIds, removedCount } = await removeElements(ctx.cdpSession, {
			selector: payload.selector,
			all,
			text: payload.text,
		})

		if (!all && allNodeIds.length > 1) {
			return respondMultipleMatches(res, allNodeIds.length, 'remove')
		}

		return { ok: true, matches: allNodeIds.length, removed: removedCount }
	},
})
