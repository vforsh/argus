import type http from 'node:http'
import type { CdpSourceHandle } from '../../sources/types.js'
import { formatError } from '@vforsh/argus-core'
import { respondJson } from '../httpUtils.js'
import { defineJsonRoute, type JsonRouteHandlerInput, type WatcherRouteDefinition } from './defineRoute.js'

/** The optional members of {@link CdpSourceHandle} that only an extension-backed source provides. */
export type ExtensionCapability = {
	[K in keyof CdpSourceHandle]-?: undefined extends CdpSourceHandle[K]
		? NonNullable<CdpSourceHandle[K]> extends (...args: never[]) => unknown
			? K
			: never
		: never
}[keyof CdpSourceHandle]

/** The capability method itself, with its optionality resolved. */
type ExtensionCapabilityFn<K extends ExtensionCapability> = NonNullable<CdpSourceHandle[K]>

type ExtensionRouteInput<TBody, TResponse extends object, TCapability extends ExtensionCapability> = {
	method: 'GET' | 'POST'
	path: string
	bodySchema?: Parameters<typeof defineJsonRoute<TBody, TResponse>>[0]['bodySchema']
	/** The source-handle method this route needs. Absent on the active source means 400 `not_available`. */
	capability: TCapability
	handle: (input: JsonRouteHandlerInput<TBody> & { capability: ExtensionCapabilityFn<TCapability> }) => Promise<TResponse | void> | TResponse | void
}

/**
 * Build a route that only an extension-backed source can serve.
 *
 * Capability used to be checked three times per request — the `extensionOnly` route flag, the
 * router's `sourceHandle` presence check, and a per-method `if (!ctx.sourceHandle?.x)` in the
 * handler — because the handle expresses capability as method optionality. This owns the third
 * check, the shared "Not available" response, and the shared `extension_action_failed` error
 * mapping, and hands the handler a method it does not have to re-narrow.
 */
export const defineExtensionRoute = <
	TBody = undefined,
	TResponse extends object = object,
	TCapability extends ExtensionCapability = ExtensionCapability,
>(
	input: ExtensionRouteInput<TBody, TResponse, TCapability>,
): WatcherRouteDefinition =>
	defineJsonRoute<TBody, TResponse>({
		method: input.method,
		path: input.path,
		bodySchema: input.bodySchema,
		extensionOnly: true,
		handle: (handlerInput) => {
			const capability = handlerInput.ctx.sourceHandle?.[input.capability] as ExtensionCapabilityFn<TCapability> | undefined
			if (!capability) {
				return respondNotAvailable(handlerInput.res)
			}

			return input.handle({ ...handlerInput, capability })
		},
		handleError: (res, error) => {
			respondJson(res, { ok: false, error: { message: formatError(error), code: 'extension_action_failed' } }, 400)
			return true
		},
	})

const respondNotAvailable = (res: http.ServerResponse): void => {
	respondJson(res, { ok: false, error: { message: 'Not available', code: 'not_available' } }, 400)
}
