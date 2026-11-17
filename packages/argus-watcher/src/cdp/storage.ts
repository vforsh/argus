import { evaluateInPage } from './pageState.js'
import type { OriginStorageType, StorageArea, StorageClearOriginRequest, StorageRequest, StorageResponse } from '@vforsh/argus-core'
import type { CdpSessionHandle } from './connection.js'
import { codedError } from '../errors.js'

const storageAccessors = {
	local: 'localStorage',
	session: 'sessionStorage',
} as const satisfies Record<StorageArea, string>

/**
 * Execute a storage operation in the attached page.
 * Throws on CDP failures or origin mismatch.
 */
export const executeStorage = async (session: CdpSessionHandle, area: StorageArea, request: StorageRequest): Promise<StorageResponse> => {
	return await evaluateInPage<StorageResponse>(session, buildStorageExpression(area, request), { timeoutMs: 5000 })
}

const buildStorageExpression = (area: StorageArea, request: StorageRequest): string => {
	return `(() => {
		const currentOrigin = (() => {
			try {
				return new URL(location.href).origin
			} catch {
				throw new Error('Cannot determine origin: page is on a non-http URL (e.g., about:blank)')
			}
		})()

		${request.origin ? `if (currentOrigin !== ${JSON.stringify(request.origin)}) { throw new Error('Origin mismatch: page is on ' + currentOrigin + ', requested ' + ${JSON.stringify(request.origin)}) }` : ''}

		const storage = ${storageAccessors[area]}
		${buildActionCode(request, area)}
	})()`
}

const buildActionCode = ({ action, key, value }: StorageRequest, area: StorageArea): string => {
	switch (action) {
		case 'get':
			return `
				const storedValue = storage.getItem(${JSON.stringify(key)})
				return { ok: true, origin: currentOrigin, key: ${JSON.stringify(key)}, exists: storedValue !== null, value: storedValue }
			`
		case 'set':
			return `
				storage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})
				return { ok: true, origin: currentOrigin, key: ${JSON.stringify(key)} }
			`
		case 'remove':
			return `
				storage.removeItem(${JSON.stringify(key)})
				return { ok: true, origin: currentOrigin, key: ${JSON.stringify(key)} }
			`
		case 'list':
			return `
				const keys = Object.keys(storage).sort()
				return { ok: true, origin: currentOrigin, keys }
			`
		case 'clear':
			return `
				const count = storage.length
				storage.clear()
				return { ok: true, origin: currentOrigin, cleared: count }
			`
		default:
			return `throw new Error('Unknown ${area}Storage action: ' + ${JSON.stringify(action)})`
	}
}

/**
 * Read the selected target's origin, failing when it has none (about:blank, data:) or when it
 * differs from `expected`. CDP storage commands are keyed by origin, so this is their scope.
 */
export const readTargetOrigin = async (session: CdpSessionHandle, expected?: string): Promise<string> => {
	const origin = await evaluateInPage<string>(session, 'location.origin', { timeoutMs: 5000 })
	if (!origin || origin === 'null') {
		throw codedError('invalid_request', 'Cannot determine origin: page is on a non-http URL (e.g., about:blank)')
	}
	if (expected && origin !== expected) {
		throw codedError('invalid_request', `Origin mismatch: page is on ${origin}, requested ${expected}`)
	}
	return origin
}

/** The selected target's storage scope: its origin and the storage key Chrome files its data under. */
export type TargetStorageScope = {
	origin: string
	/**
	 * `<origin>/` for first-party storage. An iframe embedded cross-site under third-party storage
	 * partitioning gets a partitioned key (`<origin>/^0<top-level site>`), and origin-keyed CDP
	 * commands would hit the iframe origin's first-party data instead of what the iframe sees.
	 */
	storageKey: string
}

/**
 * Resolve the selected target's origin and storage key.
 *
 * The origin comes from the page and the key from CDP in two calls; a navigation between them is
 * caught by checking the key belongs to the origin, so a mutation never runs against a page the
 * `--origin` guard did not check.
 */
export const readTargetStorageScope = async (session: CdpSessionHandle, expected?: string): Promise<TargetStorageScope> => {
	const origin = await readTargetOrigin(session, expected)
	const storageKey = await readStorageKey(session, origin)
	if (storageKey !== `${origin}/` && !storageKey.startsWith(`${origin}/^`)) {
		throw codedError('invalid_request', `The selected target navigated away from ${origin} (storage key ${storageKey}); retry`)
	}
	return { origin, storageKey }
}

const readStorageKey = async (session: CdpSessionHandle, origin: string): Promise<string> => {
	const context = session.getTargetContext()
	const frameId = context.kind === 'frame' ? context.frameId : (await session.sendAndWait('Page.getFrameTree')).frameTree?.frame.id
	try {
		const { storageKey } = await session.sendAndWait('Storage.getStorageKey', { frameId })
		return storageKey
	} catch (error) {
		// A top-level page is never partitioned, so its first-party key is safe to assume where Chrome lacks the command.
		if (context.kind === 'page' && isMethodNotFound(error)) return `${origin}/`
		throw error
	}
}

/** JSON-RPC "method not found" (-32601): how Chrome, and chrome.debugger for a domain it does not expose, refuses a command. */
export const isMethodNotFound = (error: unknown): boolean => error instanceof Error && /-32601|wasn't found/.test(error.message)

/** Chrome can take a while to drop large IndexedDB/Cache Storage data; bounded so a stall gets the CDP diagnosis. */
const CLEAR_ORIGIN_TIMEOUT_MS = 30_000

/**
 * Clear the selected target's origin data.
 *
 * Unlike page-side clears this also drops IndexedDB databases the page holds open, Cache Storage,
 * and service worker registrations. First-party storage uses `Storage.clearDataForOrigin` (which
 * also covers the origin's cookies); a partitioned iframe uses `Storage.clearDataForStorageKey`, the
 * only call that reaches the data that iframe actually sees.
 */
export const clearOriginStorage = async (
	session: CdpSessionHandle,
	request: StorageClearOriginRequest,
): Promise<TargetStorageScope & { types: OriginStorageType[] }> => {
	const scope = await readTargetStorageScope(session, request.origin)
	const types: OriginStorageType[] = !request.types || request.types.includes('all') ? ['all'] : [...new Set(request.types)]
	const storageTypes = types.join(',')
	if (scope.storageKey === `${scope.origin}/`) {
		await session.sendAndWait('Storage.clearDataForOrigin', { origin: scope.origin, storageTypes }, { timeoutMs: CLEAR_ORIGIN_TIMEOUT_MS })
	} else {
		await session.sendAndWait('Storage.clearDataForStorageKey', { storageKey: scope.storageKey, storageTypes }, { timeoutMs: CLEAR_ORIGIN_TIMEOUT_MS })
	}
	return { ...scope, types }
}
