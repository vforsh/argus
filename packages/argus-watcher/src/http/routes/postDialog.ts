import type { DialogHandleRequest, DialogHandleResponse } from '@vforsh/argus-core'
import { dialogHandleRequestSchema } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'
import { respondApiError } from '../httpUtils.js'

export const route = defineJsonRoute<DialogHandleRequest, DialogHandleResponse>({
	method: 'POST',
	path: '/dialog',
	bodySchema: dialogHandleRequestSchema,
	endpoint: 'dialog/handle',
	handle: async ({ res, ctx, body: payload }) => {
		const action = payload.action
		const dialog = ctx.getDialog()
		if (!dialog) {
			respondApiError(res, 409, 'no_active_dialog', 'No active browser dialog')
			return
		}

		if (payload.promptText != null && dialog.type !== 'prompt') {
			respondApiError(res, 409, 'dialog_not_prompt', 'Prompt text can only be sent to prompt dialogs')
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
