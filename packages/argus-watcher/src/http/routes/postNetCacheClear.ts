import type { NetCacheClearResponse } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'

/** Chrome can take a while to drop a large cache; a bounded wait gets the layered CDP diagnosis instead of a hang. */
const CACHE_CLEAR_TIMEOUT_MS = 30_000

export const route = defineJsonRoute<undefined, NetCacheClearResponse>({
	method: 'POST',
	path: '/net/cache/clear',
	endpoint: 'net/cache/clear',
	handle: async ({ ctx }) => {
		await ctx.pageCdpSession.sendAndWait('Network.clearBrowserCache', undefined, { timeoutMs: CACHE_CLEAR_TIMEOUT_MS })
		return { ok: true }
	},
})
