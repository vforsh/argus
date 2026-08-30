import type { AuthStateLoadRequest } from '@vforsh/argus-core'
import { authStateLoadRequestSchema, parseAuthStateSnapshot } from '@vforsh/argus-core'
import { applyAuthStateToSession } from '../../cdp/authState.js'
import { defineJsonRoute } from './defineRoute.js'
import { normalizeQueryValue } from '../httpUtils.js'

export const route = defineJsonRoute<AuthStateLoadRequest>({
	method: 'POST',
	path: '/auth/state/load',
	bodySchema: authStateLoadRequestSchema,
	endpoint: 'auth/state/load',
	handle: ({ ctx, body: payload }) =>
		applyAuthStateToSession({
			session: ctx.cdpSession,
			// Re-parse is cheap and keeps validation/normalization in one place.
			snapshot: parseAuthStateSnapshot(payload.snapshot, 'auth state snapshot'),
			startupUrl: normalizeQueryValue(payload.url ?? null) ?? null,
		}),
})
