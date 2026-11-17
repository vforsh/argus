import type { IndexedDbRequest, StorageArea, StorageClearOriginRequest, StorageClearOriginResponse, StorageRequest } from '@vforsh/argus-core'
import { DEFAULT_RELOAD_TIMEOUT_MS, indexedDbRequestSchema, storageClearOriginRequestSchema, storageRequestSchema } from '@vforsh/argus-core'
import type { WatcherRouteDefinition } from './defineRoute.js'
import { readNavigationBaseline } from '../../cdp/documentIdentity.js'
import { executeIndexedDb } from '../../cdp/indexedDb.js'
import { clearOriginStorage, executeStorage } from '../../cdp/storage.js'
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

const indexedDbRoute = defineJsonRoute<IndexedDbRequest>({
	method: 'POST',
	path: '/storage/indexeddb',
	bodySchema: indexedDbRequestSchema,
	endpoint: 'storage/indexeddb',
	handle: ({ ctx, body: payload }) => executeIndexedDb(ctx.cdpSession, payload),
})

const clearOriginRoute = defineJsonRoute<StorageClearOriginRequest, StorageClearOriginResponse>({
	method: 'POST',
	path: '/storage/clear',
	bodySchema: storageClearOriginRequestSchema,
	endpoint: 'storage/clear',
	handle: async ({ ctx, body: payload }) => {
		// Clear is scoped to the selected target's origin; the reload, like `/reload`, is page-scoped.
		const { origin, storageKey, types } = await clearOriginStorage(ctx.cdpSession, payload)
		if (!payload.reload) {
			return { ok: true, origin, storageKey, types, reloaded: false }
		}
		const navigatedFrom = await readNavigationBaseline({ page: ctx.pageCdpSession, target: ctx.cdpSession })
		await ctx.pageCdpSession.sendAndWait('Page.reload', { ignoreCache: false }, { timeoutMs: DEFAULT_RELOAD_TIMEOUT_MS })
		return { ok: true, origin, storageKey, types, reloaded: true, navigatedFrom }
	},
})

export const storageRoutes: WatcherRouteDefinition[] = [createStorageRoute('local'), createStorageRoute('session'), indexedDbRoute, clearOriginRoute]
