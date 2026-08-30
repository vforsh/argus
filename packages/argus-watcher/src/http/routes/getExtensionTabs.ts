import type { ExtensionTabsResponse } from '@vforsh/argus-core'
import { normalizeQueryValue } from '@vforsh/argus-core'
import { defineExtensionRoute } from './defineExtensionRoute.js'
import { emitRequest } from './types.js'

export const route = defineExtensionRoute<undefined, ExtensionTabsResponse, 'listTabs'>({
	method: 'GET',
	path: '/tabs',
	capability: 'listTabs',
	handle: async ({ res, url, ctx, capability }) => {
		const filter = {
			url: normalizeQueryValue(url.searchParams.get('url')),
			title: normalizeQueryValue(url.searchParams.get('title')),
		}

		// Emitted manually to include query metadata in the request event.
		emitRequest(ctx, res, 'tabs', filter)

		return { ok: true, tabs: await capability(filter) }
	},
})
