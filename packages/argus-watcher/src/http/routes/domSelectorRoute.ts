import type http from 'node:http'
import { respondInvalidBody, respondJson, readJsonBody } from '../httpUtils.js'

type SelectorPayload = {
	selector?: unknown
	ref?: unknown
	all?: unknown
}

/**
 * Shared parser for DOM routes that require a selector and optional `all` toggle.
 * Keeps route modules focused on the actual DOM operation.
 */
export const readDomTargetPayload = async <T extends SelectorPayload>(
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<{ payload: T; all: boolean } | null> => {
	const payload = await readJsonBody<T>(req, res)
	if (!payload) {
		return null
	}

	const hasSelector = typeof payload.selector === 'string' && payload.selector.trim() !== ''
	const hasRef = typeof payload.ref === 'string' && payload.ref.trim() !== ''
	if (hasSelector === hasRef) {
		respondInvalidBody(res, 'Exactly one of selector or ref is required')
		return null
	}

	const all = payload.all ?? false
	if (typeof all !== 'boolean') {
		respondInvalidBody(res, 'all must be a boolean')
		return null
	}

	return { payload, all }
}

/** Backwards-compatible alias used by selector-only routes while they migrate to ref support. */
export const readDomSelectorPayload = readDomTargetPayload

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

export const respondMissingElementRef = (res: http.ServerResponse, ref: string): void => {
	respondJson(
		res,
		{
			ok: false,
			error: {
				message: `Unknown or stale element ref: ${ref}. Run argus snapshot or locate again.`,
				code: 'invalid_ref',
			},
		},
		400,
	)
}

export const respondTargetResolutionError = (res: http.ServerResponse, error: unknown): boolean => {
	if (!error || typeof error !== 'object') {
		return false
	}

	const code = 'code' in error ? (error as { code?: unknown }).code : undefined
	if (code !== 'invalid_ref') {
		return false
	}

	const message = error instanceof Error && error.message ? error.message : 'Unknown or stale element ref. Run argus snapshot or locate again.'
	respondJson(res, { ok: false, error: { message, code: 'invalid_ref' } }, 400)
	return true
}
