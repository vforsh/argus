import { evaluateInPage } from './pageState.js'
import type { CdpSessionHandle } from './connection.js'

type RawStorageEntry = {
	name?: string
	value?: string
}

type RawStateSnapshot = {
	url?: unknown
	origin?: unknown
	title?: unknown
	localStorage?: RawStorageEntry[]
	sessionStorage?: RawStorageEntry[]
}

/** One read of everything the auth commands need from the live page. */
export type PageState = {
	url: string
	origin: string
	title: string | null
	localStorage: RawStorageEntry[]
	sessionStorage: RawStorageEntry[]
}

/**
 * Read the page's URL, origin, title, and web storage in one evaluation.
 *
 * Shared by cookie CRUD and auth-state export: the CRUD side needs the live origin so `--for-origin`
 * filtering can tell first-party cookies from cross-site noise without duplicating URL resolution,
 * and the snapshot side needs the storage as well.
 */
export const inspectPageState = async (session: CdpSessionHandle): Promise<PageState> => {
	const state = await evaluateInPage<unknown>(
		session,
		`(() => {
				try {
					const url = String(location.href)
					const origin = new URL(url).origin
					const collectStorage = (storage) => {
						const entries = []
						for (let index = 0; index < storage.length; index++) {
							const key = storage.key(index)
							if (key == null) {
								continue
							}
							entries.push({ name: key, value: storage.getItem(key) ?? '' })
						}
						entries.sort((left, right) => left.name.localeCompare(right.name))
						return entries
					}

					return {
						url,
						origin,
						title: typeof document.title === 'string' && document.title.trim() ? document.title.trim() : null,
						localStorage: collectStorage(localStorage),
						sessionStorage: collectStorage(sessionStorage),
					}
				} catch {
					throw new Error('Cannot determine origin: page is on a non-http URL (e.g., about:blank)')
				}
			})()`,
		{ timeoutMs: 5000, failureMessage: 'Failed to inspect page auth state' },
	)

	return normalizePageState(state)
}

/** Project raw web-storage entries onto the snapshot shape, dropping malformed ones. */
export const normalizeStorageEntries = (entries: RawStorageEntry[]): Array<{ name: string; value: string }> =>
	entries
		.filter((entry) => typeof entry?.name === 'string')
		.map((entry) => ({
			name: entry.name ?? '',
			value: typeof entry.value === 'string' ? entry.value : '',
		}))

const normalizePageState = (value: unknown): PageState => {
	const snapshot = typeof value === 'object' && value ? (value as RawStateSnapshot) : {}
	const url = typeof snapshot.url === 'string' ? snapshot.url : ''
	const origin = typeof snapshot.origin === 'string' ? snapshot.origin : ''

	if (!url || !origin) {
		throw new Error('Failed to inspect page auth state')
	}

	return {
		url,
		origin,
		title: typeof snapshot.title === 'string' && snapshot.title.trim() ? snapshot.title : null,
		localStorage: Array.isArray(snapshot.localStorage) ? snapshot.localStorage : [],
		sessionStorage: Array.isArray(snapshot.sessionStorage) ? snapshot.sessionStorage : [],
	}
}
