import type { DomTreeRequest, DomTreeResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { readDomSelectorPayload, respondMultipleMatches } from './domSelectorRoute.js'
import { emitRequest } from './types.js'
import { fetchDomSubtreeBySelector } from '../../cdp/dom.js'
import { respondJson, respondError } from '../httpUtils.js'

export const handle: RouteHandler = async (req, res, _url, ctx) => {
	const parsed = await readDomSelectorPayload<DomTreeRequest>(req, res)
	if (!parsed) {
		return
	}
	const { payload, all } = parsed

	emitRequest(ctx, res, 'dom/tree')

	try {
		const response: DomTreeResponse = await fetchDomSubtreeBySelector(ctx.cdpSession, {
			selector: payload.selector,
			depth: payload.depth,
			maxNodes: payload.maxNodes,
			all,
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
