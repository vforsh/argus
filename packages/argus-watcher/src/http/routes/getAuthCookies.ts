import type { AuthCookiesResponse } from '@vforsh/argus-core'
import { inspectAuthCookies } from '../../cdp/auth.js'
import { defineJsonRoute } from './defineRoute.js'
import { normalizeQueryValue } from '../httpUtils.js'
import { emitRequest } from './types.js'

export const route = defineJsonRoute<undefined, AuthCookiesResponse>({
	method: 'GET',
	path: '/auth/cookies',
	handle: ({ res, url, ctx }) => {
		const domain = normalizeQueryValue(url.searchParams.get('domain'))
		const includeValues = url.searchParams.get('includeValues') === 'true'

		// Emitted manually to include query metadata in the request event.
		emitRequest(ctx, res, 'auth/cookies', { domain, includeValues })

		return inspectAuthCookies(ctx.cdpSession, {
			domain: domain ?? undefined,
			includeValues,
		})
	},
})
