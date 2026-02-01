import type { StorageLocalRequest } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { executeStorageLocal } from '../../cdp/storageLocal.js'
import { respondJson, respondInvalidBody, respondError, readJsonBody } from '../httpUtils.js'

export const handle: RouteHandler = async (req, res, _url, ctx) => {
	const payload = await readJsonBody<StorageLocalRequest>(req, res)
	if (!payload) {
		return
	}

	// Validate action
	const validActions = ['get', 'set', 'remove', 'list', 'clear'] as const
	if (!payload.action || !validActions.includes(payload.action)) {
		return respondInvalidBody(res, `action must be one of: ${validActions.join(', ')}`)
	}

	// Validate key is present for get/set/remove
	if (['get', 'set', 'remove'].includes(payload.action) && (!payload.key || typeof payload.key !== 'string')) {
		return respondInvalidBody(res, 'key is required for get/set/remove actions')
	}

	// Validate value is present for set
	if (payload.action === 'set' && (payload.value === undefined || typeof payload.value !== 'string')) {
		return respondInvalidBody(res, 'value is required for set action')
	}

	emitRequest(ctx, res, 'storage/local')

	try {
		const response = await executeStorageLocal(ctx.cdpSession, payload)
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}
