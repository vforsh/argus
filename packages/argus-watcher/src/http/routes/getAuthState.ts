import type { AuthStateSnapshot } from '@vforsh/argus-core'
import { inspectAuthState } from '../../cdp/auth.js'
import { defineJsonRoute } from './defineRoute.js'
import { normalizeQueryValue } from '../httpUtils.js'
import { emitRequest } from './types.js'

export const route = defineJsonRoute<undefined, AuthStateSnapshot>({
	method: 'GET',
	path: '/auth/state',
	handle: ({ res, url, ctx }) => {
		const domain = normalizeQueryValue(url.searchParams.get('domain'))

		// Emitted manually to include query metadata in the request event.
		emitRequest(ctx, res, 'auth/state', { domain })

		const watcher = ctx.getWatcher()
		return inspectAuthState(ctx.cdpSession, {
			domain: domain ?? undefined,
			readBrowserCookies: ctx.readBrowserCookies,
			metadata: {
				exportedAt: new Date().toISOString(),
				watcherId: watcher.id,
				watcherSource: watcher.source ?? null,
			},
		})
	},
})
