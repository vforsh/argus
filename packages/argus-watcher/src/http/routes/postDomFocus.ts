import type { DomFocusRequest, DomFocusResponse } from '@vforsh/argus-core'
import { focusDomNodes } from '../../cdp/mouse.js'
import { defineDomTargetRoute } from './defineDomTargetRoute.js'

export const route = defineDomTargetRoute<DomFocusRequest, Pick<DomFocusResponse, 'focused'>>({
	path: '/dom/focus',
	endpoint: 'dom/focus',
	action: 'focus',
	run: async ({ handles, ctx }) => {
		await focusDomNodes(ctx.cdpSession, handles)
		return { focused: handles.length }
	},
})
