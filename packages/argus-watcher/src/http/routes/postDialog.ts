import type { DialogHandleRequest, DialogHandleResponse, ErrorResponse } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'
import { respondJson } from '../httpUtils.js'

export const route = defineJsonRoute<DialogHandleRequest, DialogHandleResponse>({
	method: 'POST',
	path: '/dialog',
	parseBody: true,
	endpoint: 'dialog/handle',
	validate: (payload) => {
		if (payload.action !== 'accept' && payload.action !== 'dismiss') {
			return 'Dialog action must be "accept" or "dismiss"'
		}
		return null
	},
	handle: async ({ res, ctx, body: payload }) => {
		const action = payload.action
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
})
