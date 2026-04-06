import type { NetRequestBodyPart, NetRequestBodyResponse } from '@vforsh/argus-core'
import type { RouteContext, RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { respondError, respondJson } from '../httpUtils.js'
import { normalizeNetBodyError, readNetworkBody } from '../../cdp/networkBody.js'
import { parseNetRequestLookup, resolveNetRequestLookupRecord } from './netRequestLookup.js'

export const handle: RouteHandler = async (_req, res, url, ctx) => {
	if (!ctx.netBuffer) {
		return respondJson(res, { ok: false, error: { code: 'net_disabled', message: 'Network capture is disabled for this watcher' } }, 400)
	}

	const lookup = parseNetRequestLookup(url.searchParams)
	if (!lookup) {
		return respondJson(res, { ok: false, error: { code: 'invalid_request', message: 'Either id or requestId is required' } }, 400)
	}

	const part = parseBodyPart(url.searchParams.get('part'))
	if (!part) {
		return respondJson(res, { ok: false, error: { code: 'invalid_request', message: 'part must be "request" or "response"' } }, 400)
	}

	emitRequest(ctx, res, 'net/request/body', {
		id: lookup.id,
		requestId: lookup.requestId,
		part,
	})

	const record = resolveNetRequestLookupRecord(ctx.netBuffer, lookup)
	if (!record) {
		return respondJson(res, { ok: false, error: { code: 'not_found', message: 'Network request not found' } }, 404)
	}
	const { detail: request, bodySessionId } = record

	if (!request.body[part]) {
		return respondJson(
			res,
			{ ok: false, error: { code: 'body_not_available', message: `${capitalizePart(part)} body not available for this request` } },
			404,
		)
	}

	try {
		const body = await readNetworkBody({
			session: ctx.pageCdpSession,
			request,
			sessionId: resolveBodySessionId(ctx, request.frameId, bodySessionId),
			part,
		})

		const response: NetRequestBodyResponse = {
			ok: true,
			id: request.id,
			requestId: request.requestId,
			part,
			mimeType: body.mimeType,
			body: body.body,
			base64Encoded: body.base64Encoded,
		}
		respondJson(res, response)
	} catch (error) {
		const normalizedError = normalizeNetBodyError(error, part)
		if ((normalizedError as Error & { code?: string }).code === 'body_not_available') {
			return respondJson(res, { ok: false, error: { code: 'body_not_available', message: normalizedError.message } }, 404)
		}
		respondError(res, normalizedError)
	}
}

const parseBodyPart = (value: string | null): NetRequestBodyPart | null => {
	if (!value || value === 'response') {
		return 'response'
	}
	if (value === 'request') {
		return 'request'
	}
	return null
}

const capitalizePart = (part: NetRequestBodyPart): string => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`

/**
 * Network events in extension mode should carry the child-session id that owns the request,
 * but older buffered records or transient bridge gaps can miss it. Fall back to the extension
 * source's frame map before giving up so iframe body reads stay stable after reloads.
 */
const resolveBodySessionId = (ctx: RouteContext, frameId: string | null, storedSessionId: string | null): string | null => {
	if (storedSessionId) {
		return storedSessionId
	}

	if (!frameId) {
		return null
	}

	return ctx.sourceHandle?.getFrameSessionId?.(frameId) ?? null
}
