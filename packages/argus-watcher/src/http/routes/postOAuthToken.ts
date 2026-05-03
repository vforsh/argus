import type { OAuthTokenRequest, OAuthTokenResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { readJsonBody, respondError, respondInvalidBody, respondJson } from '../httpUtils.js'

export const handle: RouteHandler = async (req, res, _url, ctx) => {
	const payload = await readJsonBody<OAuthTokenRequest>(req, res)
	if (!payload) {
		return
	}

	const validationError = validateOAuthTokenRequest(payload)
	if (validationError) {
		return respondInvalidBody(res, validationError)
	}

	if (!ctx.readOAuthToken) {
		return respondJson(
			res,
			{ ok: false, error: { message: 'OAuth tokens are only available in extension mode.', code: 'oauth_unavailable' } },
			400,
		)
	}

	emitRequest(ctx, res, 'oauth/token')

	try {
		const token = await ctx.readOAuthToken({
			scopes: payload.scopes,
			interactive: payload.interactive,
		})
		const response: OAuthTokenResponse = { ok: true, token: token.token, grantedScopes: token.grantedScopes }
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}

const validateOAuthTokenRequest = (payload: OAuthTokenRequest): string | null => {
	if (!Array.isArray(payload.scopes) || payload.scopes.length === 0) {
		return 'scopes must be a non-empty array'
	}
	for (const scope of payload.scopes) {
		if (typeof scope !== 'string' || scope.trim() === '') {
			return 'scopes must contain only non-empty strings'
		}
	}
	if (payload.interactive != null && typeof payload.interactive !== 'boolean') {
		return 'interactive must be a boolean'
	}
	return null
}
