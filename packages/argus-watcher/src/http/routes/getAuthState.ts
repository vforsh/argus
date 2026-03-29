import type { AuthStateSnapshot } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { inspectAuthState } from '../../cdp/auth.js'
import { normalizeQueryValue, respondError, respondJson } from '../httpUtils.js'

export const handle: RouteHandler = async (_req, res, url, ctx) => {
	const domain = normalizeQueryValue(url.searchParams.get('domain'))

	emitRequest(ctx, res, 'auth/state', { domain })

	try {
		const watcher = ctx.getWatcher()
		const response: AuthStateSnapshot = await inspectAuthState(ctx.cdpSession, {
			domain: domain ?? undefined,
			readBrowserCookies: ctx.readBrowserCookies,
			metadata: {
				exportedAt: new Date().toISOString(),
				watcherId: watcher.id,
				watcherSource: watcher.source ?? null,
			},
		})
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}
