import type { DomKeydownRequest, DomKeydownResponse } from '@vforsh/argus-core'
import { dispatchKeydown, parseModifiers } from '../../cdp/keyboard.js'
import { defineJsonRoute } from './defineRoute.js'

export const route = defineJsonRoute<DomKeydownRequest, DomKeydownResponse>({
	method: 'POST',
	path: '/dom/keydown',
	parseBody: true,
	endpoint: 'dom/keydown',
	validate: (payload) => {
		const hasKey = typeof payload.key === 'string' && payload.key.trim() !== ''
		const hasCode = typeof payload.code === 'string' && payload.code.trim() !== ''

		if (payload.key != null && !hasKey) {
			return 'key must be a non-empty string'
		}
		if (payload.code != null && !hasCode) {
			return 'code must be a non-empty string'
		}
		if (!hasKey && !hasCode) {
			return 'key or code is required'
		}
		if (payload.selector != null && (typeof payload.selector !== 'string' || payload.selector.trim() === '')) {
			return 'selector must be a non-empty string'
		}
		if (payload.modifiers != null && typeof payload.modifiers !== 'string') {
			return 'modifiers must be a string'
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
