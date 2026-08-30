import type { DomInfoRequest, DomInfoResponse } from '@vforsh/argus-core'
import { domInfoRequestSchema } from '@vforsh/argus-core'
import { fetchDomInfoBySelector } from '../../cdp/dom.js'
import { defineJsonRoute } from './defineRoute.js'
import { respondMultipleMatches, respondTargetResolutionError } from './domSelectorRoute.js'

export const route = defineJsonRoute<DomInfoRequest, DomInfoResponse>({
	method: 'POST',
	path: '/dom/info',
	bodySchema: domInfoRequestSchema,
	endpoint: 'dom/info',
	handle: async ({ res, ctx, body: payload }) => {
		const all = payload.all ?? false
		const response = await fetchDomInfoBySelector(ctx.cdpSession, ctx.elementRefs, {
			selector: payload.selector,
			ref: payload.ref,
			all,
			outerHtmlMaxChars: payload.outerHtmlMaxChars,
			text: payload.text,
		})

		if (!all && response.matches > 1) {
			return respondMultipleMatches(res, response.matches, 'return')
		}

		return response
	},
	handleError: respondTargetResolutionError,
})
