import type { NetRequestResponse } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'
import { emitRequest } from './types.js'
import { respondNetDisabled } from './netFilters.js'
import { parseNetRequestLookup, resolveNetRequestLookup } from './netRequestLookup.js'
import { respondApiError } from '../httpUtils.js'

export const route = defineJsonRoute<undefined, NetRequestResponse>({
	method: 'GET',
	path: '/net/request',
	handle: ({ res, url, ctx }) => {
		if (!ctx.netBuffer) {
			return respondNetDisabled(res)
		}

		const lookup = parseNetRequestLookup(url.searchParams)
		if (!lookup) {
			return respondApiError(res, 400, 'invalid_request', 'Either id or requestId is required')
		}

		emitRequest(ctx, res, 'net/request', { id: lookup.id, requestId: lookup.requestId })

		const request = resolveNetRequestLookup(ctx.netBuffer, lookup)
		if (!request) {
			return respondApiError(res, 404, 'not_found', 'Network request not found')
		}

		return { ok: true, request }
	},
})
