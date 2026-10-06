import {
	VISIBILITY_POLICIES,
	formatProtocolValidationIssues,
	visibilityRequestSchema,
	type ApiResult,
	type ErrorResponse,
	type VisibilityPolicy,
	type VisibilityRequest,
	type VisibilityResponse,
	type WatcherRecord,
} from '@vforsh/argus-core'
import { fetchWatcherJson } from '../watchers/requestWatcher.js'

/**
 * Read visibility, or apply `request` to the already resolved watcher.
 * Policy-aware mutations require a valid GET response before POST; legacy hosts must never
 * silently turn a background request into foreground activation. Transport failures throw.
 */
export const requestVisibility = async (watcher: WatcherRecord, request?: VisibilityRequest): Promise<ApiResult<VisibilityResponse>> => {
	if (request) {
		const parsed = visibilityRequestSchema.parse(request)
		if (!parsed.ok) {
			return { ok: false, error: { code: 'invalid_request', message: formatProtocolValidationIssues(parsed.issues) } }
		}
		request = parsed.value
	}
	const checked = !request || request.policy != null || request.activate === false
	if (checked) {
		const status = await fetchWatcherJson<ApiResult<VisibilityResponse>>(watcher, {
			path: '/visibility',
			timeoutMs: 5_000,
			returnErrorResponse: true,
		})
		if (!isVisibilityResponse(status)) return unsupportedVisibility(watcher.id)
		if (!request) return status
	}
	const response = await fetchWatcherJson<ApiResult<VisibilityResponse>>(watcher, {
		path: '/visibility',
		method: 'POST',
		body: request,
		timeoutMs: 5_000,
		returnErrorResponse: true,
	})
	return checked && response.ok && !isVisibilityResponse(response) ? unsupportedVisibility(watcher.id) : response
}

const isVisibilityResponse = (value: unknown): value is VisibilityResponse => {
	if (value == null || typeof value !== 'object' || (value as { ok?: unknown }).ok !== true) return false
	const response = value as { attached?: unknown; state?: unknown; policy?: unknown }
	return (
		typeof response.attached === 'boolean' &&
		(response.state === 'shown' || response.state === 'default') &&
		VISIBILITY_POLICIES.includes(response.policy as VisibilityPolicy)
	)
}

const unsupportedVisibility = (watcherId: string): ErrorResponse => ({
	ok: false,
	error: {
		code: 'not_available',
		message: `Watcher ${watcherId} does not support visibility policy checks. Restart or update the watcher, then retry.`,
	},
})
