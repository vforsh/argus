import type { DomModifyRequest, DomModifyResponse } from '@vforsh/argus-core'
import { modifyElements } from '../../cdp/dom.js'
import { defineJsonRoute } from './defineRoute.js'
import { respondMultipleMatches } from './domSelectorRoute.js'

const validTypes = ['attr', 'class', 'style', 'text', 'html']

export const route = defineJsonRoute<DomModifyRequest, DomModifyResponse>({
	method: 'POST',
	path: '/dom/modify',
	parseBody: true,
	endpoint: 'dom/modify',
	validate: (payload) => {
		if (!payload.selector || typeof payload.selector !== 'string') {
			return 'selector is required'
		}
		if (!payload.type || !validTypes.includes(payload.type)) {
			return `type must be one of: ${validTypes.join(', ')}`
		}
		if ((payload.type === 'text' || payload.type === 'html') && typeof payload.value !== 'string') {
			return 'value is required for text/html modifications'
		}
		if (typeof (payload.all ?? false) !== 'boolean') {
			return 'all must be a boolean'
		}
		return null
	},
	handle: async ({ res, ctx, body: payload }) => {
		const all = payload.all ?? false
		const { allNodeIds, modifiedCount } = await modifyElements(ctx.cdpSession, { ...payload, all })

		if (!all && allNodeIds.length > 1) {
			return respondMultipleMatches(res, allNodeIds.length, 'modify')
		}

		return { ok: true, matches: allNodeIds.length, modified: modifiedCount }
	},
})
