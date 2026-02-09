import type { DomSetFileRequest, DomSetFileResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { setFileOnResolvedNodes } from '../../cdp/dom.js'
import { getDomRootId, resolveSelectorMatches, waitForSelectorMatches } from '../../cdp/dom/selector.js'
import { respondJson, respondInvalidBody, respondError, readJsonBody } from '../httpUtils.js'

export const handle: RouteHandler = async (req, res, _url, ctx) => {
	const payload = await readJsonBody<DomSetFileRequest>(req, res)
	if (!payload) {
		return
	}

	if (!payload.selector || typeof payload.selector !== 'string') {
		return respondInvalidBody(res, 'selector is required')
	}

	if (!Array.isArray(payload.files) || payload.files.length === 0) {
		return respondInvalidBody(res, 'files array is required and must not be empty')
	}

	const all = payload.all ?? false
	if (typeof all !== 'boolean') {
		return respondInvalidBody(res, 'all must be a boolean')
	}

	const waitMs = payload.wait ?? 0
	if (typeof waitMs !== 'number' || !Number.isFinite(waitMs) || waitMs < 0) {
		return respondInvalidBody(res, 'wait must be a non-negative number (ms)')
	}

	emitRequest(ctx, res, 'dom/set-file')

	try {
		let allNodeIds: number[]
		let nodeIds: number[]

		if (waitMs > 0) {
			await ctx.cdpSession.sendAndWait('DOM.enable')
			const result = await waitForSelectorMatches(ctx.cdpSession, payload.selector, all, payload.text, waitMs)
			allNodeIds = result.allNodeIds
			nodeIds = result.nodeIds
		} else {
			await ctx.cdpSession.sendAndWait('DOM.enable')
			const rootId = await getDomRootId(ctx.cdpSession)
			const result = await resolveSelectorMatches(ctx.cdpSession, rootId, payload.selector, all, payload.text)
			allNodeIds = result.allNodeIds
			nodeIds = result.nodeIds
		}

		if (!all && allNodeIds.length > 1) {
			return respondJson(
				res,
				{
					ok: false,
					error: {
						message: `Selector matched ${allNodeIds.length} elements; pass all=true to set files on all matches`,
						code: 'multiple_matches',
					},
				},
				400,
			)
		}

		const updatedCount = await setFileOnResolvedNodes(ctx.cdpSession, nodeIds, payload.files)
		const response: DomSetFileResponse = { ok: true, matches: allNodeIds.length, updated: updatedCount }
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}
