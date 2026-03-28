import type http from 'node:http'
import { respondInvalidBody, respondJson, readJsonBody } from '../httpUtils.js'

type SelectorPayload = {
	selector?: unknown
	all?: unknown
}

/**
 * Shared parser for DOM routes that require a selector and optional `all` toggle.
 * Keeps route modules focused on the actual DOM operation.
 */
export const readDomSelectorPayload = async <T extends SelectorPayload>(
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<{ payload: T; all: boolean } | null> => {
	const payload = await readJsonBody<T>(req, res)
	if (!payload) {
		return null
	}

	if (!payload.selector || typeof payload.selector !== 'string') {
		respondInvalidBody(res, 'selector is required')
		return null
	}

	const all = payload.all ?? false
	if (typeof all !== 'boolean') {
		respondInvalidBody(res, 'all must be a boolean')
		return null
	}

	return { payload, all }
}

export const respondMultipleMatches = (res: http.ServerResponse, matches: number, action: string): void => {
	respondJson(
		res,
		{
			ok: false,
			error: {
				message: `Selector matched ${matches} elements; pass all=true to ${action} all matches`,
				code: 'multiple_matches',
			},
		},
		400,
	)
}
