import type { SnapshotRequest, SnapshotResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { fetchAccessibilitySnapshot } from '../../cdp/accessibility.js'
import { respondJson, respondInvalidBody, respondError, readJsonBody } from '../httpUtils.js'

export const handle: RouteHandler = async (req, res, _url, ctx) => {
	const payload = await readJsonBody<SnapshotRequest>(req, res)
	if (!payload) {
		return
	}

	if (payload.selector != null && (typeof payload.selector !== 'string' || payload.selector.trim() === '')) {
		return respondInvalidBody(res, 'selector must be a non-empty string')
	}

	if (payload.depth != null && (!Number.isFinite(payload.depth) || payload.depth < 0 || !Number.isInteger(payload.depth))) {
		return respondInvalidBody(res, 'depth must be a non-negative integer')
	}

	emitRequest(ctx, res, 'snapshot')

	try {
		const response: SnapshotResponse = await fetchAccessibilitySnapshot(ctx.cdpSession, {
			selector: payload.selector,
			depth: payload.depth,
			interactive: payload.interactive ?? false,
		})
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}
