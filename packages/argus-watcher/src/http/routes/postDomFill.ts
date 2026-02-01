import type { DomFillRequest, DomFillResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { fillElements } from '../../cdp/dom.js'
import { respondJson, respondInvalidBody, respondError, readJsonBody } from '../httpUtils.js'

export const handle: RouteHandler = async (req, res, _url, ctx) => {
	const payload = await readJsonBody<DomFillRequest>(req, res)
	if (!payload) {
		return
	}

	if (!payload.selector || typeof payload.selector !== 'string') {
		return respondInvalidBody(res, 'selector is required')
	}

	if (typeof payload.value !== 'string') {
		return respondInvalidBody(res, 'value is required')
	}

	const all = payload.all ?? false
	if (typeof all !== 'boolean') {
		return respondInvalidBody(res, 'all must be a boolean')
	}

	emitRequest(ctx, res, 'dom/fill')

	try {
		const { allNodeIds, filledCount } = await fillElements(ctx.cdpSession, {
			selector: payload.selector,
			value: payload.value,
			all,
			text: payload.text,
		})

		if (!all && allNodeIds.length > 1) {
			return respondJson(
				res,
				{
					ok: false,
					error: {
						message: `Selector matched ${allNodeIds.length} elements; pass all=true to fill all matches`,
						code: 'multiple_matches',
					},
				},
				400,
			)
		}

		const response: DomFillResponse = { ok: true, matches: allNodeIds.length, filled: filledCount }
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}
