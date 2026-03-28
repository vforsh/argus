import type { DomSetFileRequest, DomSetFileResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { respondMultipleMatches } from './domSelectorRoute.js'
import { emitRequest } from './types.js'
import { setFileOnResolvedNodes } from '../../cdp/dom.js'
import { resolveSelectorTargets } from '../../cdp/dom/selector.js'
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
		const { allNodeIds, nodeIds } = await resolveSelectorTargets(ctx.cdpSession, {
			selector: payload.selector,
			all,
			text: payload.text,
			waitMs,
		})

		if (!all && allNodeIds.length > 1) {
			return respondMultipleMatches(res, allNodeIds.length, 'set files on')
		}

		const updatedCount = await setFileOnResolvedNodes(ctx.cdpSession, nodeIds, payload.files)
		const response: DomSetFileResponse = { ok: true, matches: allNodeIds.length, updated: updatedCount }
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}
