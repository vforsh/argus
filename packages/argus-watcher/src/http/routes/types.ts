import type http from 'node:http'
import type { HttpRequestEventMetadata, HttpServerOptions } from '../server.js'

/** Uniform handler signature for all route modules. */
export type RouteHandler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL, ctx: RouteContext) => Promise<void> | void

/** Context passed to every route handler (alias for HttpServerOptions). */
export type RouteContext = HttpServerOptions

/** Emit an HTTP request event via `ctx.onRequest`. Replaces per-handler boilerplate. */
export const emitRequest = (
	ctx: RouteContext,
	res: http.ServerResponse,
	endpoint: HttpRequestEventMetadata['endpoint'],
	query?: HttpRequestEventMetadata['query'],
): void => {
	ctx.onRequest?.({
		endpoint,
		remoteAddress: res.req.socket.remoteAddress ?? null,
		query,
		ts: Date.now(),
	})
}
