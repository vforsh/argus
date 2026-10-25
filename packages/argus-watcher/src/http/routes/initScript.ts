import type { InitScriptAddRequest, InitScriptRemoveRequest } from '@vforsh/argus-core'
import type { WatcherRouteDefinition } from './defineRoute.js'
import { initScriptAddRequestSchema, initScriptRemoveRequestSchema } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'

export const initScriptRoutes: WatcherRouteDefinition[] = [
	defineJsonRoute({
		method: 'GET',
		path: '/page/init-script',
		endpoint: 'page/init-script',
		handle: ({ ctx }) => ctx.initScriptController.getStatus({ attached: ctx.getCdpStatus().attached }),
	}),
	defineJsonRoute<InitScriptAddRequest>({
		method: 'POST',
		path: '/page/init-script/add',
		bodySchema: initScriptAddRequestSchema,
		endpoint: 'page/init-script/add',
		handle: ({ ctx, body }) => ctx.initScriptController.add(body, ctx.getCdpStatus().attached),
	}),
	defineJsonRoute<InitScriptRemoveRequest>({
		method: 'POST',
		path: '/page/init-script/remove',
		bodySchema: initScriptRemoveRequestSchema,
		endpoint: 'page/init-script/remove',
		handle: ({ ctx, body }) => ctx.initScriptController.remove(body.id),
	}),
	defineJsonRoute({
		method: 'POST',
		path: '/page/init-script/clear',
		endpoint: 'page/init-script/clear',
		handle: ({ ctx }) => ctx.initScriptController.clear(),
	}),
]
