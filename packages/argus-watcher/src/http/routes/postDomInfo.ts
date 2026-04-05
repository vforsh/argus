import type { DomInfoRequest, DomInfoResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { readDomTargetPayload, respondMultipleMatches, respondTargetResolutionError } from './domSelectorRoute.js'
import { emitRequest } from './types.js'
import { fetchDomInfoBySelector } from '../../cdp/dom.js'
import { respondJson, respondError } from '../httpUtils.js'

export const handle: RouteHandler = async (req, res, _url, ctx) => {
	const parsed = await readDomTargetPayload<DomInfoRequest>(req, res)
	if (!parsed) {
		return
	}
	const { payload, all } = parsed

	emitRequest(ctx, res, 'dom/info')

	try {
		const response: DomInfoResponse = await fetchDomInfoBySelector(ctx.cdpSession, ctx.elementRefs, {
			selector: payload.selector,
			ref: payload.ref,
			all,
			outerHtmlMaxChars: payload.outerHtmlMaxChars,
			text: payload.text,
		})

		if (!all && response.matches > 1) {
			return respondMultipleMatches(res, response.matches, 'return')
		}

		respondJson(res, response)
	} catch (error) {
		if (respondTargetResolutionError(res, error)) {
			return
		}
		respondError(res, error)
	}
}
