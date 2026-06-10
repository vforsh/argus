import type { DomFillRequest, DomFillResponse } from '@vforsh/argus-core'
import { fillResolvedNodes } from '../../cdp/dom.js'
import { defineDomTargetRoute } from './defineDomTargetRoute.js'

export const route = defineDomTargetRoute<DomFillRequest, Pick<DomFillResponse, 'filled'>>({
	path: '/dom/fill',
	endpoint: 'dom/fill',
	action: 'fill',
	validate: (payload) => {
		if (typeof payload.value !== 'string') {
			return 'value is required'
		}
		const waitMs = payload.wait ?? 0
		if (typeof waitMs !== 'number' || !Number.isFinite(waitMs) || waitMs < 0) {
			return 'wait must be a non-negative number (ms)'
		}
		return null
	},
	run: async ({ handles, ctx, payload }) => {
		const filledCount = await fillResolvedNodes(ctx.cdpSession, handles, payload.value)
		return { filled: filledCount }
	},
})
