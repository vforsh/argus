import type http from 'node:http'
import type { RouteContext } from './routes/types.js'
import { respondJson } from './httpUtils.js'
import { watcherRoutes } from './routes/index.js'

const routes = new Map<string, (typeof watcherRoutes)[number]>(watcherRoutes.map((route) => [`${route.method} ${route.path}`, route]))

/** Dispatch an incoming request to the matching route handler, or respond 404. */
export const dispatch = (req: http.IncomingMessage, res: http.ServerResponse, url: URL, ctx: RouteContext): void => {
	const entry = routes.get(`${req.method} ${url.pathname}`)
	if (!entry || (entry.extensionOnly && !ctx.sourceHandle)) {
		respondJson(res, { ok: false, error: { message: 'Not found', code: 'not_found' } }, 404)
		return
	}
	void entry.handler(req, res, url, ctx)
}
