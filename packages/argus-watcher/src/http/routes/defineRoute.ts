import type http from 'node:http'
import type { HttpRequestEventMetadata } from '../server.js'
import type { ProtocolSchema } from '@vforsh/argus-core'
import type { RouteContext, RouteHandler } from './types.js'
import { formatProtocolValidationIssues } from '@vforsh/argus-core'
import { readJsonBody, respondError, respondInvalidBody, respondJson } from '../httpUtils.js'
import { emitRequest } from './types.js'

export type WatcherRouteDefinition = {
	method: 'GET' | 'POST'
	path: string
	handler: RouteHandler
	extensionOnly?: boolean
}

type JsonRouteInput<TBody, TResponse extends object> = {
	method: 'GET' | 'POST'
	path: string
	/**
	 * Schema that parses and validates the request body.
	 *
	 * This is the only way to read a body. There used to be a `parseBody: true` escape
	 * hatch that handed the route an unvalidated payload already typed as `TBody` — the
	 * type parameter was a lie until a hand-written `validate` closure re-proved it, and
	 * ~450 LOC of per-route `typeof` checks and casts grew in that gap. Omit this and the
	 * handler receives no body at all.
	 */
	bodySchema?: ProtocolSchema<TBody>
	endpoint?: HttpRequestEventMetadata['endpoint']
	extensionOnly?: boolean
	handle: (input: JsonRouteHandlerInput<TBody>) => Promise<TResponse | void> | TResponse | void
	handleError?: (res: http.ServerResponse, error: unknown) => boolean | void
}

export type JsonRouteHandlerInput<TBody> = {
	req: http.IncomingMessage
	res: http.ServerResponse
	url: URL
	ctx: RouteContext
	body: TBody
}

/** Build a JSON route with common body parsing, schema validation, event emission, and error handling. */
export const defineJsonRoute = <TBody = undefined, TResponse extends object = object>(
	input: JsonRouteInput<TBody, TResponse>,
): WatcherRouteDefinition => ({
	method: input.method,
	path: input.path,
	extensionOnly: input.extensionOnly,
	handler: async (req, res, url, ctx) => {
		let body = undefined as TBody
		if (input.bodySchema) {
			const rawBody = await readJsonBody(req, res)
			if (rawBody == null) {
				return
			}

			const parsed = input.bodySchema.parse(rawBody)
			if (!parsed.ok) {
				return respondInvalidBody(res, formatProtocolValidationIssues(parsed.issues))
			}
			body = parsed.value
		}

		if (input.endpoint) {
			emitRequest(ctx, res, input.endpoint)
		}

		try {
			const response = await input.handle({ req, res, url, ctx, body })
			if (response) {
				respondJson(res, response)
			}
		} catch (error) {
			if (input.handleError?.(res, error)) {
				return
			}
			respondError(res, error)
		}
	},
})
