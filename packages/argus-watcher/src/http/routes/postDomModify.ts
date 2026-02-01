import type { DomModifyRequest, DomModifyResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { modifyElements } from '../../cdp/dom.js'
import { respondJson, respondInvalidBody, respondError, readJsonBody } from '../httpUtils.js'

export const handle: RouteHandler = async (req, res, _url, ctx) => {
	const payload = await readJsonBody<DomModifyRequest>(req, res)
	if (!payload) {
		return
	}

	if (!payload.selector || typeof payload.selector !== 'string') {
		return respondInvalidBody(res, 'selector is required')
	}

	const validTypes = ['attr', 'class', 'style', 'text', 'html']
	if (!payload.type || !validTypes.includes(payload.type)) {
		return respondInvalidBody(res, `type must be one of: ${validTypes.join(', ')}`)
	}

	if ((payload.type === 'text' || payload.type === 'html') && typeof payload.value !== 'string') {
		return respondInvalidBody(res, 'value is required for text/html modifications')
	}

	const all = payload.all ?? false
	if (typeof all !== 'boolean') {
		return respondInvalidBody(res, 'all must be a boolean')
	}

	emitRequest(ctx, res, 'dom/modify')

	try {
		const { allNodeIds, modifiedCount } = await modifyElements(ctx.cdpSession, {
			...payload,
			all,
		})

		if (!all && allNodeIds.length > 1) {
			return respondJson(
				res,
				{
					ok: false,
					error: {
						message: `Selector matched ${allNodeIds.length} elements; pass all=true to modify all matches`,
						code: 'multiple_matches',
					},
				},
				400,
			)
		}

		const response: DomModifyResponse = { ok: true, matches: allNodeIds.length, modified: modifiedCount }
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}
