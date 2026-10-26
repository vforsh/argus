import type { DomHoverRequest, DomHoverResponse } from '@vforsh/argus-core'
import { domHoverRequestSchema } from '@vforsh/argus-core'
import { hoverAtPoint, hoverDomNodes } from '../../cdp/mouse.js'
import { defineDomTargetRoute } from './defineDomTargetRoute.js'

export const route = defineDomTargetRoute<DomHoverRequest, Pick<DomHoverResponse, 'hovered'>>({
	path: '/dom/hover',
	endpoint: 'dom/hover',
	bodySchema: domHoverRequestSchema,
	action: 'hover',
	run: async ({ handles, ctx }) => {
		await hoverDomNodes(ctx.cdpSession, handles)
		return { hovered: handles.length }
	},
	runAtPoint: async ({ x, y, ctx }) => {
		await hoverAtPoint(ctx.cdpSession, x, y)
		return { hovered: 1 }
	},
})
