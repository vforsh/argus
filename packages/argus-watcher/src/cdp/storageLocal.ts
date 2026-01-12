import type {
	StorageLocalRequest,
	StorageLocalResponse,
	StorageLocalGetResponse,
	StorageLocalSetResponse,
	StorageLocalRemoveResponse,
	StorageLocalListResponse,
	StorageLocalClearResponse,
} from '@vforsh/argus-core'
import type { CdpSessionHandle } from './connection.js'

/**
 * Execute a localStorage operation in the attached page.
 * Throws an Error on CDP failures or origin mismatch.
 */
export const executeStorageLocal = async (
	session: CdpSessionHandle,
	request: StorageLocalRequest,
): Promise<StorageLocalResponse> => {
	const { action, key, value, origin } = request

	// Build the JS expression based on action
	const expression = buildExpression(action, key, value, origin)

	const result = await session.sendAndWait(
		'Runtime.evaluate',
		{
			expression,
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

	return payload.result?.value as StorageLocalResponse
}

const buildExpression = (
	action: StorageLocalRequest['action'],
	key: string | undefined,
	value: string | undefined,
	origin: string | undefined,
): string => {
	// IIFE to execute and return JSON-serializable result
	return `(() => {
		const currentOrigin = (() => {
			try {
				return new URL(location.href).origin
			} catch {
				throw new Error('Cannot determine origin: page is on a non-http URL (e.g., about:blank)')
			}
		})()

		${origin ? `if (currentOrigin !== ${JSON.stringify(origin)}) { throw new Error('Origin mismatch: page is on ' + currentOrigin + ', requested ' + ${JSON.stringify(origin)}) }` : ''}

		${buildActionCode(action, key, value)}
	})()`
}

const buildActionCode = (
	action: StorageLocalRequest['action'],
	key: string | undefined,
	value: string | undefined,
): string => {
	switch (action) {
		case 'get':
			return `
				const val = localStorage.getItem(${JSON.stringify(key)})
				return { ok: true, origin: currentOrigin, key: ${JSON.stringify(key)}, exists: val !== null, value: val }
			`
		case 'set':
			return `
				localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})
				return { ok: true, origin: currentOrigin, key: ${JSON.stringify(key)} }
			`
		case 'remove':
			return `
				localStorage.removeItem(${JSON.stringify(key)})
				return { ok: true, origin: currentOrigin, key: ${JSON.stringify(key)} }
			`
		case 'list':
			return `
				const keys = Object.keys(localStorage).sort()
				return { ok: true, origin: currentOrigin, keys }
			`
		case 'clear':
			return `
				const count = localStorage.length
				localStorage.clear()
				return { ok: true, origin: currentOrigin, cleared: count }
			`
		default:
			// Should never happen due to type safety, but include for robustness
			return `throw new Error('Unknown action: ' + ${JSON.stringify(action)})`
	}
}
