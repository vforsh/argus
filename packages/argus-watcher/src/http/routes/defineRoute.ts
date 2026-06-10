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
	bodySchema?: ProtocolSchema<TBody>
	parseBody?: boolean
	/**
	 * Route-specific body validation, run after schema parsing and before the
	 * request event is emitted. Return an error message to respond 400
	 * `invalid_request`, or null when the body is valid. Prefer `bodySchema`
	 * when a protocol schema exists; use this for validation rules that a
	 * schema cannot express.
	 */
	validate?: (body: TBody) => string | null
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
		const shouldReadBody = input.bodySchema != null || input.parseBody === true
		const rawBody = shouldReadBody ? await readJsonBody<unknown>(req, res) : undefined
		if (shouldReadBody && rawBody == null) {
			return
		}

		const parsedBody = input.bodySchema?.parse(rawBody)
		if (parsedBody && !parsedBody.ok) {
			return respondInvalidBody(res, formatProtocolValidationIssues(parsedBody.issues))
		}

		const body = (parsedBody?.value ?? rawBody) as TBody
		const validationError = input.validate?.(body)
		if (validationError) {
			return respondInvalidBody(res, validationError)
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
