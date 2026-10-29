import type { ReloadRequest, ReloadResponse } from '@vforsh/argus-core'
import { DEFAULT_RELOAD_TIMEOUT_MS, reloadRequestSchema } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'
import { readNavigationBaseline } from '../../cdp/documentIdentity.js'

export const route = defineJsonRoute<ReloadRequest, ReloadResponse>({
	method: 'POST',
	path: '/reload',
	bodySchema: reloadRequestSchema,
	endpoint: 'reload',
	handle: async ({ ctx, body: payload }) => {
		// Reload is page-scoped in CDP, even when the active Argus target is an iframe.
		// The deadline is the watcher's, not the client's: a timeout here gets the layered CDP diagnosis
		// (`defineJsonRoute` → `respondCdpError`). Direct CDP had no deadline at all and the extension
		// bridge 30s, both hidden behind the CLI's old 10s transport timeout.
		// Chrome answers once the reload starts, while the old document still runs: the baseline lets
		// `--until` polls skip it (see `cdp/documentIdentity.ts`).
		const navigatedFrom = await readNavigationBaseline({ page: ctx.pageCdpSession, target: ctx.cdpSession })
		await ctx.pageCdpSession.sendAndWait(
			'Page.reload',
			{ ignoreCache: payload.ignoreCache ?? false },
			{ timeoutMs: payload.timeoutMs ?? DEFAULT_RELOAD_TIMEOUT_MS },
		)
		return { ok: true, navigatedFrom }
	},
})
