import type { ReloadRequest, ReloadResponse } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'

export const route = defineJsonRoute<ReloadRequest, ReloadResponse>({
	method: 'POST',
	path: '/reload',
	parseBody: true,
	endpoint: 'reload',
	handle: async ({ ctx, body: payload }) => {
		// Reload is page-scoped in CDP, even when the active Argus target is an iframe.
		await ctx.pageCdpSession.sendAndWait('Page.reload', {
			ignoreCache: payload.ignoreCache ?? false,
		})
		return { ok: true }
	},
})
