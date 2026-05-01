import type { DialogHandleRequest, DialogHandleResponse, ErrorResponse } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'
import { respondInvalidBody, respondJson } from '../httpUtils.js'

export const handle = defineJsonRoute<DialogHandleRequest, DialogHandleResponse>({
	method: 'POST',
	path: '/dialog',
	parseBody: true,
	endpoint: 'dialog/handle',
	handle: async ({ res, ctx, body: payload }) => {
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
				{
					ok: false,
					error: { message: 'Prompt text can only be sent to prompt dialogs', code: 'dialog_not_prompt' },
				} satisfies ErrorResponse,
				409,
			)
			return
		}

		await ctx.pageCdpSession.sendAndWait('Page.handleJavaScriptDialog', {
			accept: action === 'accept',
			promptText: payload.promptText,
		})

		const response: DialogHandleResponse = {
			ok: true,
			action,
			dialog,
		}
		return response
	},
}).handler
