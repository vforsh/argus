import type { DomFillRequest, DomFillResponse } from '@vforsh/argus-core'
import { domFillRequestSchema } from '@vforsh/argus-core'
import { fillResolvedNodes } from '../../cdp/dom.js'
import { defineDomTargetRoute } from './defineDomTargetRoute.js'

export const route = defineDomTargetRoute<DomFillRequest, Pick<DomFillResponse, 'filled'>>({
	path: '/dom/fill',
	endpoint: 'dom/fill',
	bodySchema: domFillRequestSchema,
	action: 'fill',
	run: async ({ handles, ctx, payload }) => {
		const filledCount = await fillResolvedNodes(ctx.cdpSession, handles, payload.value)
		return { filled: filledCount }
	},
})
