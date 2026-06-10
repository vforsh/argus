import type { ExtensionTabsResponse } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'
import { normalizeQueryValue, respondJson } from '../httpUtils.js'
import { emitRequest } from './types.js'

export const route = defineJsonRoute<undefined, ExtensionTabsResponse>({
	method: 'GET',
	path: '/tabs',
	extensionOnly: true,
	handle: async ({ res, url, ctx }) => {
		if (!ctx.sourceHandle?.listTabs) {
			return respondJson(res, { ok: false, error: { message: 'Not available', code: 'not_available' } }, 400)
		}

		// Emitted manually to include query metadata in the request event.
		emitRequest(ctx, res, 'tabs', {
			url: url.searchParams.get('url') ?? undefined,
			title: url.searchParams.get('title') ?? undefined,
		})

		const tabs = await ctx.sourceHandle.listTabs({
			url: normalizeQueryValue(url.searchParams.get('url')),
			title: normalizeQueryValue(url.searchParams.get('title')),
		})
		return { ok: true, tabs }
	},
})
