import type { DomKeydownRequest, DomKeydownResponse } from '@vforsh/argus-core'
import { dispatchKeydown, parseModifiers } from '../../cdp/keyboard.js'
import { defineJsonRoute } from './defineRoute.js'

export const route = defineJsonRoute<DomKeydownRequest, DomKeydownResponse>({
	method: 'POST',
	path: '/dom/keydown',
	parseBody: true,
	endpoint: 'dom/keydown',
	validate: (payload) => {
		if (!payload.key || typeof payload.key !== 'string') {
			return 'key is required'
		}
		if (payload.selector != null && (typeof payload.selector !== 'string' || payload.selector.trim() === '')) {
			return 'selector must be a non-empty string'
		}
		try {
			parseModifiers(payload.modifiers)
		} catch (error) {
			return error instanceof Error ? error.message : 'invalid modifiers'
		}
		return null
	},
	handle: async ({ ctx, body: payload }) => {
		const result = await dispatchKeydown(ctx.cdpSession, {
			key: payload.key,
			selector: payload.selector,
			modifiers: parseModifiers(payload.modifiers),
		})
		return { ok: true, key: result.key, modifiers: result.modifiers, focused: result.focused }
	},
})
