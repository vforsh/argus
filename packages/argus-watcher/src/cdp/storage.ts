import type { StorageArea, StorageRequest, StorageResponse } from '@vforsh/argus-core'
import type { CdpSessionHandle } from './connection.js'

const storageAccessors = {
	local: 'localStorage',
	session: 'sessionStorage',
} as const satisfies Record<StorageArea, string>

/**
 * Execute a storage operation in the attached page.
 * Throws on CDP failures or origin mismatch.
 */
export const executeStorage = async (session: CdpSessionHandle, area: StorageArea, request: StorageRequest): Promise<StorageResponse> => {
	const result = await session.sendAndWait(
		'Runtime.evaluate',
		{
			expression: buildStorageExpression(area, request),
			awaitPromise: false,
			returnByValue: true,
		},
		{ timeoutMs: 5000 },
	)

	const payload = result as {
		result?: { type?: string; value?: unknown }
		exceptionDetails?: { text?: string; exception?: { description?: string } }
	}

	if (payload.exceptionDetails) {
		const message = payload.exceptionDetails.exception?.description ?? payload.exceptionDetails.text ?? 'Unknown error'
		throw new Error(message)
	}

	return payload.result?.value as StorageResponse
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
