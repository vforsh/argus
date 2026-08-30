import type { LocateLabelRequest, LocateResponse, LocateRoleRequest, LocateTextRequest, ProtocolSchema } from '@vforsh/argus-core'
import { locateLabelRequestSchema, locateRoleRequestSchema, locateTextRequestSchema } from '@vforsh/argus-core'
import type { RouteContext } from './types.js'
import type { WatcherRouteDefinition } from './defineRoute.js'
import { locateByLabel, locateByRole, locateByText } from '../../cdp/locate.js'
import { defineJsonRoute } from './defineRoute.js'
import { respondMultipleMatches } from './domSelectorRoute.js'

type LocatePayload = {
	all?: unknown
	exact?: unknown
	role?: unknown
	text?: unknown
	label?: unknown
}

type LocateRouteConfig<TPayload extends LocatePayload> = {
	endpoint: 'locate/role' | 'locate/text' | 'locate/label'
	bodySchema: ProtocolSchema<TPayload>
	run: (ctx: RouteContext, payload: TPayload) => Promise<LocateResponse>
}

const createLocateRoute = <TPayload extends LocatePayload>(config: LocateRouteConfig<TPayload>): WatcherRouteDefinition =>
	defineJsonRoute<TPayload, LocateResponse>({
		method: 'POST',
		path: `/${config.endpoint}`,
		bodySchema: config.bodySchema,
		endpoint: config.endpoint,
		handle: async ({ res, ctx, body: payload }) => {
			const response = await config.run(ctx, payload)
			if (payload.all !== true && response.matches > 1) {
				return respondMultipleMatches(res, response.matches, 'return')
			}
			return response
		},
	})

export const locateRoutes: WatcherRouteDefinition[] = [
	createLocateRoute<LocateRoleRequest>({
		endpoint: 'locate/role',
		bodySchema: locateRoleRequestSchema,
		run: (ctx, payload) => locateByRole(ctx.cdpSession, ctx.elementRefs, payload),
	}),
	createLocateRoute<LocateTextRequest>({
		endpoint: 'locate/text',
		bodySchema: locateTextRequestSchema,
		run: (ctx, payload) => locateByText(ctx.cdpSession, ctx.elementRefs, payload),
	}),
	createLocateRoute<LocateLabelRequest>({
		endpoint: 'locate/label',
		bodySchema: locateLabelRequestSchema,
		run: (ctx, payload) => locateByLabel(ctx.cdpSession, ctx.elementRefs, payload),
	}),
]
