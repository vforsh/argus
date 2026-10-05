/**
 * Persistent identity of this browser profile.
 *
 * Every browser running the extension shares one extension id, so the CLI can't tell two
 * browsers apart from what the extension reports. A random id kept in `chrome.storage.local`
 * is per profile and survives browser restarts and extension reloads (but not reinstalling
 * the extension, which clears its storage).
 */
const STORAGE_KEY = 'argusBrowserInstanceId'

let pending: Promise<string | null> | null = null

/** The profile's instance id, generated on first use. `null` only when storage is unavailable. */
export function getBrowserInstanceId(): Promise<string | null> {
	pending ??= loadOrCreate().catch((error: unknown) => {
		console.error('[BrowserInstance] Failed to read or persist instance id:', error)
		pending = null
		return null
	})
	return pending
}

async function loadOrCreate(): Promise<string> {
	const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY]
	if (typeof stored === 'string' && stored !== '') {
		return stored
	}
	const created = crypto.randomUUID()
	await chrome.storage.local.set({ [STORAGE_KEY]: created })
	return created
}
