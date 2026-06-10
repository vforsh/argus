import type { SnapshotRequest, SnapshotResponse } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'
import { fetchAccessibilitySnapshot } from '../../cdp/accessibility.js'

export const route = defineJsonRoute<SnapshotRequest, SnapshotResponse>({
	method: 'POST',
	path: '/snapshot',
	parseBody: true,
	endpoint: 'snapshot',
	validate: (payload) => {
		if (payload.selector != null && (typeof payload.selector !== 'string' || payload.selector.trim() === '')) {
			return 'selector must be a non-empty string'
		}
		if (payload.depth != null && (!Number.isFinite(payload.depth) || payload.depth < 0 || !Number.isInteger(payload.depth))) {
			return 'depth must be a non-negative integer'
		}
		return null
	},
	handle: ({ ctx, body: payload }) =>
		fetchAccessibilitySnapshot(
			ctx.cdpSession,
			{
				selector: payload.selector,
				depth: payload.depth,
				interactive: payload.interactive ?? false,
			},
			ctx.elementRefs,
		),
})
