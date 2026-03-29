import type { StorageAction, StorageArea, StorageRequest } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { executeStorage } from '../../cdp/storage.js'
import { respondError, respondInvalidBody, respondJson, readJsonBody } from '../httpUtils.js'

const validActions = ['get', 'set', 'remove', 'list', 'clear'] as const satisfies readonly StorageAction[]
const keyActions = new Set<StorageAction>(['get', 'set', 'remove'])

const endpointByArea: Record<StorageArea, 'storage/local' | 'storage/session'> = {
	local: 'storage/local',
	session: 'storage/session',
}

/** Create a POST /storage/<area> route handler. */
export const createStorageHandler = (area: StorageArea): RouteHandler => {
	return async (req, res, _url, ctx) => {
		const payload = await readJsonBody<StorageRequest>(req, res)
		if (!payload) {
			return
		}

		const validationError = validateStoragePayload(payload)
		if (validationError) {
			return respondInvalidBody(res, validationError)
		}

		emitRequest(ctx, res, endpointByArea[area])

		try {
			const response = await executeStorage(ctx.cdpSession, area, payload)
			respondJson(res, response)
		} catch (error) {
			respondError(res, error)
		}
	}
}

const validateStoragePayload = (payload: StorageRequest): string | null => {
	if (!payload.action || !validActions.includes(payload.action)) {
		return `action must be one of: ${validActions.join(', ')}`
	}

	if (keyActions.has(payload.action) && (!payload.key || typeof payload.key !== 'string')) {
		return 'key is required for get/set/remove actions'
	}

	if (payload.action === 'set' && (payload.value === undefined || typeof payload.value !== 'string')) {
		return 'value is required for set action'
	}

	return null
}
