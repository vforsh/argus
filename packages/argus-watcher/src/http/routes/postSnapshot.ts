import type { SnapshotRequest, SnapshotResponse } from '@vforsh/argus-core'
import { snapshotRequestSchema } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'
import { fetchAccessibilitySnapshot } from '../../cdp/accessibility.js'

export const route = defineJsonRoute<SnapshotRequest, SnapshotResponse>({
	method: 'POST',
	path: '/snapshot',
	bodySchema: snapshotRequestSchema,
	endpoint: 'snapshot',
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
