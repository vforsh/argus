import type { DomInfoRequest, DomInfoResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { readDomSelectorPayload, respondMultipleMatches } from './domSelectorRoute.js'
import { emitRequest } from './types.js'
import { fetchDomInfoBySelector } from '../../cdp/dom.js'
import { respondJson, respondError } from '../httpUtils.js'

export const handle: RouteHandler = async (req, res, _url, ctx) => {
	const parsed = await readDomSelectorPayload<DomInfoRequest>(req, res)
	if (!parsed) {
		return
	}
	const { payload, all } = parsed

	emitRequest(ctx, res, 'dom/info')

	try {
		const response: DomInfoResponse = await fetchDomInfoBySelector(ctx.cdpSession, {
			selector: payload.selector,
			all,
			outerHtmlMaxChars: payload.outerHtmlMaxChars,
			text: payload.text,
		})

		if (!all && response.matches > 1) {
			return respondMultipleMatches(res, response.matches, 'return')
		}

		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}
