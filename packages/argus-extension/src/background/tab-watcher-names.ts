import { readStorageValue, writeStorageValue } from './page-keyed-store.js'

/** The watcher id a tab last ran under, and the origin it was showing then. */
export type TabWatcherName = {
	tabId: number
	watcherId: string
	origin: string
	updatedAt: number
}

const STORAGE_KEY = 'tabWatcherNames'
const MAX_ENTRIES = 100

/**
 * Remembers which watcher id each tab last ran under, so a re-attach keeps its name.
 *
 * Without it every re-attach drew a fresh auto id (`extension-2`, `extension-3`, …), and whatever
 * the caller had keyed to the old id — an injected recorder, a note in an agent's context — was
 * silently addressing nothing. Kept in `chrome.storage.session`: tab ids only mean something until
 * the browser restarts, and the service worker can restart at any time in between. The origin check
 * stops a tab that moved to an unrelated site from inheriting the old site's name.
 */
export class TabWatcherNames {
	private entries: TabWatcherName[] | null = null
	/** Updates run one at a time, so two near-simultaneous attaches can't drop each other's entry. */
	private updates: Promise<void> = Promise.resolve()

	constructor(private readonly storageArea: chrome.storage.StorageArea | undefined = chrome.storage?.session) {}

	/** The name `tabId` last had, when it still shows the same origin as `url`. */
	async recall(tabId: number, url: string | undefined): Promise<string | null> {
		const origin = toOrigin(url)
		if (!origin) return null
		const entry = (await this.load()).find((candidate) => candidate.tabId === tabId)
		return entry && entry.origin === origin ? entry.watcherId : null
	}

	async remember(tabId: number, url: string | undefined, watcherId: string): Promise<void> {
		const origin = toOrigin(url)
		if (!origin) return
		await this.update((entries) =>
			[{ tabId, watcherId, origin, updatedAt: Date.now() }, ...entries.filter((entry) => entry.tabId !== tabId)].slice(0, MAX_ENTRIES),
		)
	}

	/** Drop a closed tab; Chrome never reuses its id, so the entry could only go stale. */
	async forget(tabId: number): Promise<void> {
		await this.update((entries) => (entries.some((entry) => entry.tabId === tabId) ? entries.filter((entry) => entry.tabId !== tabId) : null))
	}

	/** Apply `change` to the loaded entries and save; `null` means nothing changed. */
	private update(change: (entries: TabWatcherName[]) => TabWatcherName[] | null): Promise<void> {
		this.updates = this.updates.then(async () => {
			const next = change(await this.load())
			if (!next) return
			this.entries = next
			await this.save()
		}).catch((error) => console.error('[TabWatcherNames] Failed to update names:', error))
		return this.updates
	}

	private async load(): Promise<TabWatcherName[]> {
		if (this.entries) return this.entries
		let stored: unknown
		try {
			stored = this.storageArea ? await readStorageValue<unknown>(this.storageArea, STORAGE_KEY) : undefined
		} catch (error) {
			console.error('[TabWatcherNames] Failed to load names:', error)
		}
		this.entries ??= Array.isArray(stored) ? stored.filter(isTabWatcherName) : []
		return this.entries
	}

	private async save(): Promise<void> {
		if (!this.storageArea) return
		try {
			await writeStorageValue(this.storageArea, { [STORAGE_KEY]: this.entries ?? [] })
		} catch (error) {
			console.error('[TabWatcherNames] Failed to save names:', error)
		}
	}
}

/** The site a tab shows; `file:` pages have an opaque origin, so they all count as one. */
const toOrigin = (url: string | undefined): string | null => {
	if (!url) return null
	try {
		const parsed = new URL(url)
		if (parsed.protocol === 'file:') return 'file://'
		return parsed.origin === 'null' ? null : parsed.origin
	} catch {
		return null
	}
}

const isTabWatcherName = (value: unknown): value is TabWatcherName => {
	const entry = value as Partial<TabWatcherName> | null
	return (
		typeof entry?.tabId === 'number' &&
		typeof entry.watcherId === 'string' &&
		typeof entry.origin === 'string' &&
		typeof entry.updatedAt === 'number'
	)
}
