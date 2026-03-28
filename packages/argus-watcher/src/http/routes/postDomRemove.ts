import type { DomRemoveRequest, DomRemoveResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { readDomSelectorPayload, respondMultipleMatches } from './domSelectorRoute.js'
import { emitRequest } from './types.js'
import { removeElements } from '../../cdp/dom.js'
import { respondJson, respondError } from '../httpUtils.js'

export const handle: RouteHandler = async (req, res, _url, ctx) => {
	const parsed = await readDomSelectorPayload<DomRemoveRequest>(req, res)
	if (!parsed) {
		return
	}
	const { payload, all } = parsed

	emitRequest(ctx, res, 'dom/remove')

	try {
		const { allNodeIds, removedCount } = await removeElements(ctx.cdpSession, {
			selector: payload.selector,
			all,
			text: payload.text,
		})

		if (!all && allNodeIds.length > 1) {
			return respondMultipleMatches(res, allNodeIds.length, 'remove')
		}

		const response: DomRemoveResponse = { ok: true, matches: allNodeIds.length, removed: removedCount }
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}
