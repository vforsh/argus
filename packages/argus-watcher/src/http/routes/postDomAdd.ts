import type { DomAddRequest, DomAddResponse } from '@vforsh/argus-core'
import { domAddRequestSchema } from '@vforsh/argus-core'
import { insertAdjacentHtml } from '../../cdp/dom.js'
import { resolveDomSelectorMatches } from '../../cdp/mouse.js'
import { defineJsonRoute } from './defineRoute.js'
import { respondJson } from '../httpUtils.js'

export const route = defineJsonRoute<DomAddRequest, DomAddResponse>({
	method: 'POST',
	path: '/dom/add',
	bodySchema: domAddRequestSchema,
	endpoint: 'dom/add',
	handle: async ({ res, ctx, body: payload }) => {
		const all = payload.all ?? false
		const { nth, expect } = payload
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
			return { ok: true, matches: 0, inserted: 0 }
		}

		const nodeIds = selectDomAddNodeIds(allNodeIds, { all, nth })
		const insertedCount = await insertAdjacentHtml(ctx.cdpSession, {
			nodeIds,
			html: payload.html,
			position: payload.position,
			text: payload.text ?? false,
		})

		return { ok: true, matches: allNodeIds.length, inserted: insertedCount }
	},
})

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
