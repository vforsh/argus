import type { NetRequestResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { normalizeQueryValue, respondJson } from '../httpUtils.js'

export const handle: RouteHandler = (_req, res, url, ctx) => {
	if (!ctx.netBuffer) {
		return respondJson(res, { ok: false, error: { code: 'net_disabled', message: 'Network capture is disabled for this watcher' } }, 400)
	}

	const id = parsePositiveInt(url.searchParams.get('id'))
	const requestId = normalizeQueryValue(url.searchParams.get('requestId'))
	if (id == null && !requestId) {
		return respondJson(res, { ok: false, error: { code: 'invalid_request', message: 'Either id or requestId is required' } }, 400)
	}

	emitRequest(ctx, res, 'net/request', {
		id: id ?? undefined,
		requestId: requestId ?? undefined,
	})

	const request = id != null ? ctx.netBuffer.getById(id) : requestId ? ctx.netBuffer.getByRequestId(requestId) : null
	if (!request) {
		return respondJson(res, { ok: false, error: { code: 'not_found', message: 'Network request not found' } }, 404)
	}

	const response: NetRequestResponse = { ok: true, request }
	respondJson(res, response)
}

const parsePositiveInt = (value: string | null): number | null => {
	if (!value) {
		return null
	}

	const parsed = Number(value)
	if (!Number.isSafeInteger(parsed) || parsed < 1) {
		return null
	}

	return parsed
}
