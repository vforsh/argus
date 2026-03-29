import type { AuthStateLoadRequest } from '@vforsh/argus-core'
import { parseAuthStateSnapshot } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { applyAuthStateToSession } from '../../cdp/authState.js'
import { normalizeQueryValue, respondError, respondInvalidBody, respondJson, readJsonBody } from '../httpUtils.js'

export const handle: RouteHandler = async (req, res, _url, ctx) => {
	const payload = await readJsonBody<AuthStateLoadRequest>(req, res)
	if (!payload) {
		return
	}

	if (!payload.snapshot) {
		return respondInvalidBody(res, 'snapshot is required')
	}

	if (payload.url !== undefined && typeof payload.url !== 'string') {
		return respondInvalidBody(res, 'url must be a string when provided')
	}

	let snapshot
	try {
		snapshot = parseAuthStateSnapshot(payload.snapshot, 'auth state snapshot')
	} catch (error) {
		return respondInvalidBody(res, error instanceof Error ? error.message : String(error))
	}

	const startupUrl = normalizeQueryValue(payload.url ?? null)
	emitRequest(ctx, res, 'auth/state/load')

	try {
		const response = await applyAuthStateToSession({
			session: ctx.cdpSession,
			snapshot,
			startupUrl: startupUrl ?? null,
		})
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}
