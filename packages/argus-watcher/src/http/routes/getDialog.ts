import type { DialogStatusResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { respondJson } from '../httpUtils.js'

export const handle: RouteHandler = (_req, res, _url, ctx) => {
	emitRequest(ctx, res, 'dialog/status')

	const response: DialogStatusResponse = {
		ok: true,
		dialog: ctx.getDialog(),
	}

	respondJson(res, response)
}
