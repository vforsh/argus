import type { ShutdownResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { respondJson } from '../httpUtils.js'

export const handle: RouteHandler = (_req, res, _url, ctx) => {
	emitRequest(ctx, res, 'shutdown')

	const response: ShutdownResponse = { ok: true }
	respondJson(res, response)

	if (ctx.onShutdown) {
		queueMicrotask(() => {
			void ctx.onShutdown?.()
		})
	}
}
