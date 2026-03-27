import type { AuthCookiesResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { inspectAuthCookies } from '../../cdp/auth.js'
import { normalizeQueryValue, respondError, respondJson } from '../httpUtils.js'

export const handle: RouteHandler = async (_req, res, url, ctx) => {
	const domain = normalizeQueryValue(url.searchParams.get('domain'))
	const includeValues = url.searchParams.get('includeValues') === 'true'

	emitRequest(ctx, res, 'auth/cookies', { domain, includeValues })

	try {
		const response: AuthCookiesResponse = await inspectAuthCookies(ctx.cdpSession, {
			domain: domain ?? undefined,
			includeValues,
		})
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}
