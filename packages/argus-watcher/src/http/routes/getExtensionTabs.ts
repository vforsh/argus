import type { ExtensionTabsResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { normalizeQueryValue, respondError, respondJson } from '../httpUtils.js'

export const handle: RouteHandler = async (_req, res, url, ctx) => {
	if (!ctx.sourceHandle?.listTabs) {
		return respondJson(res, { ok: false, error: { message: 'Not available', code: 'not_available' } }, 400)
	}

	emitRequest(ctx, res, 'tabs', {
		url: url.searchParams.get('url') ?? undefined,
		title: url.searchParams.get('title') ?? undefined,
	})

	try {
		const tabs = await ctx.sourceHandle.listTabs({
			url: normalizeQueryValue(url.searchParams.get('url')),
			title: normalizeQueryValue(url.searchParams.get('title')),
		})
		respondJson(res, { ok: true, tabs } satisfies ExtensionTabsResponse)
	} catch (error) {
		respondError(res, error)
	}
}
