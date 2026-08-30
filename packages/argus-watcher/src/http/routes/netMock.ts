import type { NetMockAddRequest, NetMockRemoveRequest } from '@vforsh/argus-core'
import type { WatcherRouteDefinition } from './defineRoute.js'
import { netMockAddRequestSchema, netMockRemoveRequestSchema } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'

export const netMockRoutes: WatcherRouteDefinition[] = [
	defineJsonRoute({
		method: 'GET',
		path: '/net/mock',
		endpoint: 'net/mock',
		handle: ({ ctx }) => ctx.netMockController.getStatus({ attached: ctx.getCdpStatus().attached }),
	}),
	defineJsonRoute<NetMockAddRequest>({
		method: 'POST',
		path: '/net/mock/add',
		bodySchema: netMockAddRequestSchema,
		endpoint: 'net/mock/add',
		handle: ({ ctx, body }) => ctx.netMockController.addRule(body, ctx.getCdpStatus().attached),
	}),
	defineJsonRoute<NetMockRemoveRequest>({
		method: 'POST',
		path: '/net/mock/remove',
		bodySchema: netMockRemoveRequestSchema,
		endpoint: 'net/mock/remove',
		handle: ({ ctx, body }) => ctx.netMockController.removeRule(body.id),
	}),
	defineJsonRoute({
		method: 'POST',
		path: '/net/mock/clear',
		endpoint: 'net/mock/clear',
		handle: ({ ctx }) => ctx.netMockController.clearRules(),
	}),
]
