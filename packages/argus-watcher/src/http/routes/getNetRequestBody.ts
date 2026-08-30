import { hasErrorCode } from '../../errors.js'
import type { NetRequestBodyPart, NetRequestBodyResponse } from '@vforsh/argus-core'
import type { RouteContext } from './types.js'
import { defineJsonRoute } from './defineRoute.js'
import { emitRequest } from './types.js'
import { normalizeNetBodyError, readNetworkBody } from '../../cdp/networkBody.js'
import { respondNetDisabled } from './netFilters.js'
import { parseNetRequestLookup, resolveNetRequestLookupRecord } from './netRequestLookup.js'
import { respondApiError } from '../httpUtils.js'

export const route = defineJsonRoute<undefined, NetRequestBodyResponse>({
	method: 'GET',
	path: '/net/request/body',
	handle: async ({ res, url, ctx }) => {
		if (!ctx.netBuffer) {
			return respondNetDisabled(res)
		}

		const lookup = parseNetRequestLookup(url.searchParams)
		if (!lookup) {
			return respondApiError(res, 400, 'invalid_request', 'Either id or requestId is required')
		}

		const part = parseBodyPart(url.searchParams.get('part'))
		if (!part) {
			return respondApiError(res, 400, 'invalid_request', 'part must be "request" or "response"')
		}

		emitRequest(ctx, res, 'net/request/body', { id: lookup.id, requestId: lookup.requestId, part })

		const record = resolveNetRequestLookupRecord(ctx.netBuffer, lookup)
		if (!record) {
			return respondApiError(res, 404, 'not_found', 'Network request not found')
		}
		const { detail: request, bodySessionId } = record

		if (!request.body[part]) {
			return respondApiError(res, 404, 'body_not_available', `${capitalizePart(part)} body not available for this request`)
		}

		try {
			const body = await readNetworkBody({
				session: ctx.pageCdpSession,
				request,
				sessionId: resolveBodySessionId(ctx, request.frameId, bodySessionId),
				part,
			})

			return {
				ok: true,
				id: request.id,
				requestId: request.requestId,
				part,
				mimeType: body.mimeType,
				body: body.body,
				base64Encoded: body.base64Encoded,
			}
		} catch (error) {
			// normalizeNetBodyError maps CDP failures onto stable codes; body_not_available stays a 404.
			const normalizedError = normalizeNetBodyError(error, part)
			if (hasErrorCode(normalizedError, 'body_not_available')) {
				return respondApiError(res, 404, 'body_not_available', normalizedError.message)
			}
			throw normalizedError
		}
	},
})

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
