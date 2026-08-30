/**
 * Shared persistence plumbing for the extension's page-scoped history stores.
 *
 * `target-selection-history` and `target-visibility-history` are the same shape of store —
 * a capped, most-recent-first list of page-keyed entries, loaded once and saved through a
 * serialized chain — and had grown line-for-line copies of every piece: the two
 * `chrome.storage` promise wrappers, the persistence factory (differing only in its key),
 * the load-once guard, the save chain, and the text/sort helpers.
 */

/** Read one key from a `chrome.storage` area, rejecting on `runtime.lastError`. */
export const readStorageValue = async <T>(storageArea: chrome.storage.StorageArea, key: string): Promise<T | undefined> =>
	new Promise<T | undefined>((resolve, reject) => {
		storageArea.get(key, (items) => {
			const error = chrome.runtime.lastError
			if (error) {
				reject(new Error(error.message))
				return
			}
			resolve(items[key] as T | undefined)
		})
	})

/** Write keys into a `chrome.storage` area, rejecting on `runtime.lastError`. */
export const writeStorageValue = async (storageArea: chrome.storage.StorageArea, items: Record<string, unknown>): Promise<void> =>
	new Promise<void>((resolve, reject) => {
		storageArea.set(items, () => {
			const error = chrome.runtime.lastError
			if (error) {
				reject(new Error(error.message))
				return
			}
			resolve()
		})
	})

/** Trim a value to a non-empty string, or `null`. */
export const normalizeOptionalText = (value: unknown): string | null => {
	if (typeof value !== 'string') {
		return null
	}

	const trimmed = value.trim()
	return trimmed === '' ? null : trimmed
}

/** Sort comparator putting the most recently updated entry first. */
export const sortByUpdatedAtDesc = (left: { updatedAt: number }, right: { updatedAt: number }): number => right.updatedAt - left.updatedAt

/** How a store reads and writes its entries. */
export type StorePersistence<TEntry> = {
	load: () => Promise<TEntry[]>
	save: (entries: TEntry[]) => Promise<void>
}

/**
 * Build a `chrome.storage`-backed persistence for one storage key.
 *
 * @param sanitize Applied on load, since anything may be sitting under the key.
 */
export const createChromeStorePersistence = <TEntry>(
	storageKey: string,
	sanitize: (value: unknown) => TEntry[],
	storageArea: chrome.storage.StorageArea = chrome.storage.local,
): StorePersistence<TEntry> => ({
	load: async () => sanitize(await readStorageValue<unknown>(storageArea, storageKey)),
	save: async (entries) => {
		await writeStorageValue(storageArea, { [storageKey]: entries })
	},
})

/**
 * A capped list of entries loaded once and saved through a serialized chain.
 *
 * Load and save failures are logged and swallowed: a store that cannot reach
 * `chrome.storage` degrades to in-memory rather than breaking the popup.
 */
export class PageKeyedStore<TEntry extends { pageKey: string; updatedAt: number }> {
	protected entries: TEntry[] = []
	private loadPromise: Promise<void> | null = null
	private saveChain: Promise<void> = Promise.resolve()

	constructor(
		private readonly persistence: StorePersistence<TEntry>,
		protected readonly maxEntries: number,
		private readonly label: string,
	) {}

	/** Load on first use; later calls await the same load. */
	protected async ensureLoaded(): Promise<void> {
		if (!this.loadPromise) {
			this.loadPromise = this.persistence
				.load()
				.then((entries) => {
					this.entries = entries.slice(0, this.maxEntries)
				})
				.catch((error) => {
					console.error(`[${this.label}] Failed to load history:`, error)
					this.entries = []
				})
		}

		await this.loadPromise
	}

	/** Persist the current entries, serialized behind any in-flight save. */
	protected async persist(): Promise<void> {
		this.saveChain = this.saveChain
			.catch(() => undefined)
			.then(() => this.persistence.save(this.entries))
			.catch((error) => {
				console.error(`[${this.label}] Failed to save history:`, error)
			})

		await this.saveChain
	}

	/** Move an entry to the front, replacing any entry with the same page key. */
	protected upsert(entry: TEntry): void {
		this.entries = [entry, ...this.entries.filter((candidate) => candidate.pageKey !== entry.pageKey)].slice(0, this.maxEntries)
	}

	/** Find the entry for a page key. */
	protected findByPageKey(pageKey: string): TEntry | null {
		return this.entries.find((entry) => entry.pageKey === pageKey) ?? null
	}
}
