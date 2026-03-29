import type { DialogHandleRequest, DialogHandleResponse, ErrorResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { readJsonBody, respondError, respondInvalidBody, respondJson } from '../httpUtils.js'

export const handle: RouteHandler = async (req, res, _url, ctx) => {
	const payload = await readJsonBody<DialogHandleRequest>(req, res)
	if (!payload) {
		return
	}

	emitRequest(ctx, res, 'dialog/handle')

	const action = payload.action
	if (action !== 'accept' && action !== 'dismiss') {
		respondInvalidBody(res, 'Dialog action must be "accept" or "dismiss"')
		return
	}

	const dialog = ctx.getDialog()
	if (!dialog) {
		respondJson(res, { ok: false, error: { message: 'No active browser dialog', code: 'no_active_dialog' } } satisfies ErrorResponse, 409)
		return
	}

	if (payload.promptText != null && dialog.type !== 'prompt') {
		respondJson(
			res,
			{ ok: false, error: { message: 'Prompt text can only be sent to prompt dialogs', code: 'dialog_not_prompt' } } satisfies ErrorResponse,
			409,
		)
		return
	}

	try {
		await ctx.pageCdpSession.sendAndWait('Page.handleJavaScriptDialog', {
			accept: action === 'accept',
			promptText: payload.promptText,
		})

		const response: DialogHandleResponse = {
			ok: true,
			action,
			dialog,
		}
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}
