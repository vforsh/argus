import type http from 'node:http'
import { respondApiError } from '../httpUtils.js'
import { BACKGROUND_CAPTURE_UNAVAILABLE_MESSAGE, isCaptureAllowed } from '../../cdp/capturePolicy.js'
import { hasErrorCode } from '../../errors.js'
import type { RouteContext } from './types.js'

/** Respond when headful visual capture could violate a background visibility policy. */
export const respondCaptureUnavailable = (res: http.ServerResponse, ctx: RouteContext): boolean => {
	if (isCaptureAllowed(ctx.visibilityController.getPolicy)) {
		return false
	}

	respondApiError(res, 400, 'not_available', BACKGROUND_CAPTURE_UNAVAILABLE_MESSAGE)
	return true
}

/** Keep a raced service-level background-policy rejection on the same 400 `not_available` contract. */
export const handleCaptureError = (res: http.ServerResponse, error: unknown): boolean => {
	if (!hasErrorCode(error, 'not_available')) {
		return false
	}

	respondApiError(res, 400, 'not_available', error instanceof Error ? error.message : String(error))
	return true
}
