import type { DomSetFileRequest, DomSetFileResponse } from '@vforsh/argus-core'
import { domSetFileRequestSchema } from '@vforsh/argus-core'
import { setFileOnResolvedNodes } from '../../cdp/dom.js'
import { resolveSelectorTargets } from '../../cdp/dom/selector.js'
import { defineJsonRoute } from './defineRoute.js'
import { respondMultipleMatches } from './domSelectorRoute.js'

export const route = defineJsonRoute<DomSetFileRequest, DomSetFileResponse>({
	method: 'POST',
	path: '/dom/set-file',
	bodySchema: domSetFileRequestSchema,
	endpoint: 'dom/set-file',
	handle: async ({ res, ctx, body: payload }) => {
		const all = payload.all ?? false
		const { allNodeIds, nodeIds } = await resolveSelectorTargets(ctx.cdpSession, {
			selector: payload.selector,
			all,
			text: payload.text,
			waitMs: payload.wait ?? 0,
		})

		if (!all && allNodeIds.length > 1) {
			return respondMultipleMatches(res, allNodeIds.length, 'set files on')
		}

		const updatedCount = await setFileOnResolvedNodes(ctx.cdpSession, nodeIds, payload.files)
		return { ok: true, matches: allNodeIds.length, updated: updatedCount }
	},
})
