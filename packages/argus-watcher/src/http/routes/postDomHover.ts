import type { DomHoverRequest, DomHoverResponse } from '@vforsh/argus-core'
import { hoverDomNodes } from '../../cdp/mouse.js'
import { defineDomTargetRoute } from './defineDomTargetRoute.js'

export const route = defineDomTargetRoute<DomHoverRequest, Pick<DomHoverResponse, 'hovered'>>({
	path: '/dom/hover',
	endpoint: 'dom/hover',
	action: 'hover',
	run: async ({ handles, ctx }) => {
		await hoverDomNodes(ctx.cdpSession, handles)
		return { hovered: handles.length }
	},
})
