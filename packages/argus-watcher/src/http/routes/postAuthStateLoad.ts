import type { AuthStateLoadRequest } from '@vforsh/argus-core'
import { parseAuthStateSnapshot } from '@vforsh/argus-core'
import { applyAuthStateToSession } from '../../cdp/authState.js'
import { defineJsonRoute } from './defineRoute.js'
import { normalizeQueryValue } from '../httpUtils.js'

export const route = defineJsonRoute<AuthStateLoadRequest>({
	method: 'POST',
	path: '/auth/state/load',
	parseBody: true,
	endpoint: 'auth/state/load',
	validate: (payload) => {
		if (!payload.snapshot) {
			return 'snapshot is required'
		}
		if (payload.url !== undefined && typeof payload.url !== 'string') {
			return 'url must be a string when provided'
		}
		try {
			parseAuthStateSnapshot(payload.snapshot, 'auth state snapshot')
		} catch (error) {
			return error instanceof Error ? error.message : String(error)
		}
		return null
	},
	handle: ({ ctx, body: payload }) =>
		applyAuthStateToSession({
			session: ctx.cdpSession,
			// Re-parse is cheap and keeps validation/normalization in one place.
			snapshot: parseAuthStateSnapshot(payload.snapshot, 'auth state snapshot'),
			startupUrl: normalizeQueryValue(payload.url ?? null) ?? null,
		}),
})
