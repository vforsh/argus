import type { DomKeydownRequest, DomKeydownResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { dispatchKeydown, parseModifiers } from '../../cdp/keyboard.js'
import { respondJson, respondInvalidBody, respondError, readJsonBody } from '../httpUtils.js'

export const handle: RouteHandler = async (req, res, _url, ctx) => {
	const payload = await readJsonBody<DomKeydownRequest>(req, res)
	if (!payload) {
		return
	}

	if (!payload.key || typeof payload.key !== 'string') {
		return respondInvalidBody(res, 'key is required')
	}

	if (payload.selector != null && (typeof payload.selector !== 'string' || payload.selector.trim() === '')) {
		return respondInvalidBody(res, 'selector must be a non-empty string')
	}

	let modifiers: number
	try {
		modifiers = parseModifiers(payload.modifiers)
	} catch (error) {
		return respondInvalidBody(res, error instanceof Error ? error.message : 'invalid modifiers')
	}

	emitRequest(ctx, res, 'dom/keydown')

	try {
		const result = await dispatchKeydown(ctx.cdpSession, {
			key: payload.key,
			selector: payload.selector,
			modifiers,
		})
		const response: DomKeydownResponse = { ok: true, key: result.key, modifiers: result.modifiers, focused: result.focused }
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}
