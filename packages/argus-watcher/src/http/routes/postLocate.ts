import type { LocateLabelRequest, LocateResponse, LocateRoleRequest, LocateTextRequest } from '@vforsh/argus-core'
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
	requiredField: 'role' | 'text' | 'label'
	run: (ctx: RouteContext, payload: TPayload) => Promise<LocateResponse>
}

const createLocateRoute = <TPayload extends LocatePayload>(config: LocateRouteConfig<TPayload>): WatcherRouteDefinition =>
	defineJsonRoute<TPayload, LocateResponse>({
		method: 'POST',
		path: `/${config.endpoint}`,
		parseBody: true,
		endpoint: config.endpoint,
		validate: (payload) => {
			const required = payload[config.requiredField]
			if (typeof required !== 'string' || required.trim() === '') {
				return `${config.requiredField} is required`
			}
			if (payload.all != null && typeof payload.all !== 'boolean') {
				return 'all must be a boolean'
			}
			if (payload.exact != null && typeof payload.exact !== 'boolean') {
				return 'exact must be a boolean'
			}
			return null
		},
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
		requiredField: 'role',
		run: (ctx, payload) => locateByRole(ctx.cdpSession, ctx.elementRefs, payload),
	}),
	createLocateRoute<LocateTextRequest>({
		endpoint: 'locate/text',
		requiredField: 'text',
		run: (ctx, payload) => locateByText(ctx.cdpSession, ctx.elementRefs, payload),
	}),
	createLocateRoute<LocateLabelRequest>({
		endpoint: 'locate/label',
		requiredField: 'label',
		run: (ctx, payload) => locateByLabel(ctx.cdpSession, ctx.elementRefs, payload),
	}),
]
