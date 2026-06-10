import type { NetRequestResponse } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'
import { emitRequest } from './types.js'
import { respondNetDisabled } from './netFilters.js'
import { parseNetRequestLookup, resolveNetRequestLookup } from './netRequestLookup.js'
import { respondJson } from '../httpUtils.js'

export const route = defineJsonRoute<undefined, NetRequestResponse>({
	method: 'GET',
	path: '/net/request',
	handle: ({ res, url, ctx }) => {
		if (!ctx.netBuffer) {
			return respondNetDisabled(res)
		}

		const lookup = parseNetRequestLookup(url.searchParams)
		if (!lookup) {
			return respondJson(res, { ok: false, error: { code: 'invalid_request', message: 'Either id or requestId is required' } }, 400)
		}

		emitRequest(ctx, res, 'net/request', { id: lookup.id, requestId: lookup.requestId })

		const request = resolveNetRequestLookup(ctx.netBuffer, lookup)
		if (!request) {
			return respondJson(res, { ok: false, error: { code: 'not_found', message: 'Network request not found' } }, 404)
		}

		return { ok: true, request }
	},
})
