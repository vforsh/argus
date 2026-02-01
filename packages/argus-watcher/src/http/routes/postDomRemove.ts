import type { DomRemoveRequest, DomRemoveResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { removeElements } from '../../cdp/dom.js'
import { respondJson, respondInvalidBody, respondError, readJsonBody } from '../httpUtils.js'

export const handle: RouteHandler = async (req, res, _url, ctx) => {
	const payload = await readJsonBody<DomRemoveRequest>(req, res)
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

	emitRequest(ctx, res, 'dom/remove')

	try {
		const { allNodeIds, removedCount } = await removeElements(ctx.cdpSession, {
			selector: payload.selector,
			all,
			text: payload.text,
		})

		if (!all && allNodeIds.length > 1) {
			return respondJson(
				res,
				{
					ok: false,
					error: {
						message: `Selector matched ${allNodeIds.length} elements; pass all=true to remove all matches`,
						code: 'multiple_matches',
					},
				},
				400,
			)
		}

		const response: DomRemoveResponse = { ok: true, matches: allNodeIds.length, removed: removedCount }
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}
