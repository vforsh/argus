import type { DomAddRequest, DomAddResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { insertAdjacentHtml } from '../../cdp/dom.js'
import { resolveDomSelectorMatches } from '../../cdp/mouse.js'
import { respondJson, respondInvalidBody, respondError, readJsonBody } from '../httpUtils.js'

export const handle: RouteHandler = async (req, res, _url, ctx) => {
	const payload = await readJsonBody<DomAddRequest>(req, res)
	if (!payload) {
		return
	}

	if (!payload.selector || typeof payload.selector !== 'string') {
		return respondInvalidBody(res, 'selector is required')
	}

	if (!payload.html || typeof payload.html !== 'string') {
		return respondInvalidBody(res, 'html is required')
	}

	const validPositions = ['beforebegin', 'afterbegin', 'beforeend', 'afterend']
	if (payload.position && !validPositions.includes(payload.position)) {
		return respondInvalidBody(res, `position must be one of: ${validPositions.join(', ')}`)
	}

	const all = payload.all ?? false
	if (typeof all !== 'boolean') {
		return respondInvalidBody(res, 'all must be a boolean')
	}

	const nth = payload.nth
	if (nth != null && (!Number.isFinite(nth) || !Number.isInteger(nth) || nth < 0)) {
		return respondInvalidBody(res, 'nth must be a non-negative integer')
	}

	const expect = payload.expect
	if (expect != null && (!Number.isFinite(expect) || !Number.isInteger(expect) || expect < 0)) {
		return respondInvalidBody(res, 'expect must be a non-negative integer')
	}

	const text = payload.text ?? false
	if (typeof text !== 'boolean') {
		return respondInvalidBody(res, 'text must be a boolean')
	}

	if (all && nth != null) {
		return respondInvalidBody(res, 'nth cannot be combined with all=true')
	}

	emitRequest(ctx, res, 'dom/add')

	try {
		const { allNodeIds } = await resolveDomSelectorMatches(ctx.cdpSession, payload.selector, true)

		if (expect != null && allNodeIds.length !== expect) {
			return respondJson(
				res,
				{
					ok: false,
					error: {
						message: `Expected ${expect} matches for selector "${payload.selector}", found ${allNodeIds.length}`,
						code: 'unexpected_matches',
					},
				},
				400,
			)
		}

		if (nth != null && nth >= allNodeIds.length) {
			return respondJson(
				res,
				{
					ok: false,
					error: {
						message: `nth index ${nth} is out of range for ${allNodeIds.length} matches`,
						code: 'nth_out_of_range',
					},
				},
				400,
			)
		}

		if (!all && nth == null && allNodeIds.length > 1) {
			return respondJson(
				res,
				{
					ok: false,
					error: {
						message: `Selector matched ${allNodeIds.length} elements; pass --all to insert at all matches (or use --nth/--first)`,
						code: 'multiple_matches',
					},
				},
				400,
			)
		}

		if (allNodeIds.length === 0) {
			const response: DomAddResponse = { ok: true, matches: 0, inserted: 0 }
			return respondJson(res, response)
		}

		const nodeIds = selectDomAddNodeIds(allNodeIds, { all, nth })
		const { insertedCount } = await insertAdjacentHtml(ctx.cdpSession, {
			nodeIds,
			html: payload.html,
			position: payload.position,
			text,
		})

		const response: DomAddResponse = { ok: true, matches: allNodeIds.length, inserted: insertedCount }
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}

export const selectDomAddNodeIds = (allNodeIds: number[], options: { all: boolean; nth?: number }): number[] => {
	if (options.all) {
		return allNodeIds
	}

	if (options.nth != null) {
		const nodeId = allNodeIds[options.nth]
		return nodeId == null ? [] : [nodeId]
	}

	return allNodeIds.slice(0, 1)
}
