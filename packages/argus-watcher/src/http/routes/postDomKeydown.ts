import type { DomKeydownRequest, DomKeydownResponse } from '@vforsh/argus-core'
import { domKeydownRequestSchema } from '@vforsh/argus-core'
import { dispatchKeydown, parseModifiers } from '../../cdp/keyboard.js'
import { defineJsonRoute } from './defineRoute.js'

export const route = defineJsonRoute<DomKeydownRequest, DomKeydownResponse>({
	method: 'POST',
	path: '/dom/keydown',
	bodySchema: domKeydownRequestSchema,
	endpoint: 'dom/keydown',
	handle: async ({ ctx, body: payload }) => {
		const result = await dispatchKeydown(ctx.cdpSession, {
			key: payload.key,
			code: payload.code,
			selector: payload.selector,
			modifiers: parseModifiers(payload.modifiers),
		})
		return {
			ok: true,
			key: result.key,
			code: result.code,
			modifiers: result.modifiers,
			focused: result.focused,
			event: result.event,
		}
	},
})
