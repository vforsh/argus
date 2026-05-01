import type { SnapshotRequest, SnapshotResponse } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'
import { emitRequest } from './types.js'
import { fetchAccessibilitySnapshot } from '../../cdp/accessibility.js'
import { respondInvalidBody } from '../httpUtils.js'

export const handle = defineJsonRoute<SnapshotRequest, SnapshotResponse>({
	method: 'POST',
	path: '/snapshot',
	parseBody: true,
	handle: async ({ res, ctx, body: payload }) => {
		if (payload.selector != null && (typeof payload.selector !== 'string' || payload.selector.trim() === '')) {
			return respondInvalidBody(res, 'selector must be a non-empty string')
		}

		if (payload.depth != null && (!Number.isFinite(payload.depth) || payload.depth < 0 || !Number.isInteger(payload.depth))) {
			return respondInvalidBody(res, 'depth must be a non-negative integer')
		}

		emitRequest(ctx, res, 'snapshot')
		return fetchAccessibilitySnapshot(
			ctx.cdpSession,
			{
				selector: payload.selector,
				depth: payload.depth,
				interactive: payload.interactive ?? false,
			},
			ctx.elementRefs,
		)
	},
}).handler
