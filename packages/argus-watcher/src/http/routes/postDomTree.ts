import type { DomTreeRequest, DomTreeResponse } from '@vforsh/argus-core'
import { fetchDomSubtreeBySelector } from '../../cdp/dom.js'
import { defineJsonRoute } from './defineRoute.js'
import { respondMultipleMatches, validateDomTargetBody } from './domSelectorRoute.js'

export const route = defineJsonRoute<DomTreeRequest, DomTreeResponse>({
	method: 'POST',
	path: '/dom/tree',
	parseBody: true,
	endpoint: 'dom/tree',
	validate: validateDomTargetBody,
	handle: async ({ res, ctx, body: payload }) => {
		const all = payload.all ?? false
		const response = await fetchDomSubtreeBySelector(ctx.cdpSession, {
			selector: payload.selector,
			depth: payload.depth,
			maxNodes: payload.maxNodes,
			all,
			text: payload.text,
		})

		if (!all && response.matches > 1) {
			return respondMultipleMatches(res, response.matches, 'return')
		}

		return response
	},
})
