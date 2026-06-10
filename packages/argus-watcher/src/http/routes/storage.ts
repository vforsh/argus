import type { StorageAction, StorageArea, StorageRequest } from '@vforsh/argus-core'
import type { WatcherRouteDefinition } from './defineRoute.js'
import { executeStorage } from '../../cdp/storage.js'
import { defineJsonRoute } from './defineRoute.js'

const validActions = ['get', 'set', 'remove', 'list', 'clear'] as const satisfies readonly StorageAction[]
const keyActions = new Set<StorageAction>(['get', 'set', 'remove'])

const endpointByArea: Record<StorageArea, 'storage/local' | 'storage/session'> = {
	local: 'storage/local',
	session: 'storage/session',
}

/** Build a POST /storage/<area> route. */
const createStorageRoute = (area: StorageArea): WatcherRouteDefinition =>
	defineJsonRoute<StorageRequest>({
		method: 'POST',
		path: `/storage/${area}`,
		parseBody: true,
		endpoint: endpointByArea[area],
		validate: validateStoragePayload,
		handle: ({ ctx, body: payload }) => executeStorage(ctx.cdpSession, area, payload),
	})

export const storageRoutes: WatcherRouteDefinition[] = [createStorageRoute('local'), createStorageRoute('session')]

function validateStoragePayload(payload: StorageRequest): string | null {
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
