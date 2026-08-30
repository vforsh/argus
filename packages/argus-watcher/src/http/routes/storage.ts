import type { StorageArea, StorageRequest } from '@vforsh/argus-core'
import { storageRequestSchema } from '@vforsh/argus-core'
import type { WatcherRouteDefinition } from './defineRoute.js'
import { executeStorage } from '../../cdp/storage.js'
import { defineJsonRoute } from './defineRoute.js'

const endpointByArea: Record<StorageArea, 'storage/local' | 'storage/session'> = {
	local: 'storage/local',
	session: 'storage/session',
}

/** Build a POST /storage/<area> route. */
const createStorageRoute = (area: StorageArea): WatcherRouteDefinition =>
	defineJsonRoute<StorageRequest>({
		method: 'POST',
		path: `/storage/${area}`,
		bodySchema: storageRequestSchema,
		endpoint: endpointByArea[area],
		handle: ({ ctx, body: payload }) => executeStorage(ctx.cdpSession, area, payload),
	})

export const storageRoutes: WatcherRouteDefinition[] = [createStorageRoute('local'), createStorageRoute('session')]
