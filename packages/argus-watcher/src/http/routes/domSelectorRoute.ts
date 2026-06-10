import type http from 'node:http'
import { respondJson } from '../httpUtils.js'

type SelectorPayload = {
	selector?: unknown
	ref?: unknown
	all?: unknown
}

/**
 * Validate the shared DOM target body shape (exactly one of selector/ref, plus
 * an optional `all` toggle). Returns an error message, or null when valid.
 * Used as the base `validate` step by DOM routes built on `defineJsonRoute`.
 */
export const validateDomTargetBody = (payload: SelectorPayload): string | null => {
	const hasSelector = typeof payload.selector === 'string' && payload.selector.trim() !== ''
	const hasRef = typeof payload.ref === 'string' && payload.ref.trim() !== ''
	if (hasSelector === hasRef) {
		return 'Exactly one of selector or ref is required'
	}

	if (typeof (payload.all ?? false) !== 'boolean') {
		return 'all must be a boolean'
	}

	return null
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
