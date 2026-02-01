import type { DomTreeRequest, DomTreeResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { fetchDomSubtreeBySelector } from '../../cdp/dom.js'
import { respondJson, respondInvalidBody, respondError, readJsonBody } from '../httpUtils.js'

export const handle: RouteHandler = async (req, res, _url, ctx) => {
	const payload = await readJsonBody<DomTreeRequest>(req, res)
	if (!payload) {
		return
	}

	if (!payload.selector || typeof payload.selector !== 'string') {
		return respondInvalidBody(res, 'selector is required')
	}

	const all = payload.all ?? false
	if (typeof all !== 'boolean') {
		return respondInvalidBody(res, 'all must be a boolean')
	}

	emitRequest(ctx, res, 'dom/tree')

	try {
		const response: DomTreeResponse = await fetchDomSubtreeBySelector(ctx.cdpSession, {
			selector: payload.selector,
			depth: payload.depth,
			maxNodes: payload.maxNodes,
			all,
			text: payload.text,
		})

		// Enforce "single match" policy server-side when all=false
		if (!all && response.matches > 1) {
			return respondJson(
				res,
				{
					ok: false,
					error: {
						message: `Selector matched ${response.matches} elements; pass all=true to return all matches`,
						code: 'multiple_matches',
					},
				},
				400,
			)
		}

		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}
