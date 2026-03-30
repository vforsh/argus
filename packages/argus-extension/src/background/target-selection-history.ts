export type SelectionTarget = {
	type: 'page' | 'iframe'
	frameId: string | null
	title: string | null
	url: string | null
}

export type RememberedTargetSelection =
	| {
			pageKey: string
			pageUrl: string
			updatedAt: number
			target: { type: 'page' }
	  }
	| {
			pageKey: string
			pageUrl: string
			updatedAt: number
			target: {
				type: 'iframe'
				url: string | null
				title: string | null
			}
	  }

export type TargetSelectionHistoryPersistence = {
	load: () => Promise<RememberedTargetSelection[]>
	save: (entries: RememberedTargetSelection[]) => Promise<void>
}

type RememberedSelectionDraft = Partial<RememberedTargetSelection> & {
	target?: { type?: string; url?: unknown; title?: unknown }
}

const DEFAULT_STORAGE_KEY = 'targetSelectionHistory'
const DEFAULT_MAX_ENTRIES = 20

/**
 * Group history by the stable document path instead of the full URL so replay survives
 * nonce/hash/query churn. The iframe hint itself still uses strict matching and fails closed.
 */
export const normalizeSelectionPageKey = (pageUrl: string): string => {
	try {
		const parsed = new URL(pageUrl)
		return `${parsed.origin}${parsed.pathname || '/'}`
	} catch {
		return pageUrl.split('#', 1)[0] || pageUrl
	}
}

export const matchRememberedIframeTarget = (entry: RememberedTargetSelection, targets: SelectionTarget[]): SelectionTarget | null => {
	if (entry.target.type !== 'iframe') {
		return null
	}
	const rememberedIframe = entry.target
	const iframeTargets = getIframeTargets(targets)

	if (rememberedIframe.url) {
		return pickSingleTargetMatch(iframeTargets, (target) => target.url === rememberedIframe.url)
	}

	if (!rememberedIframe.title) {
		return null
	}

	return pickSingleTargetMatch(iframeTargets, (target) => normalizeTargetTitle(target.title) === rememberedIframe.title)
}

export class TargetSelectionHistoryStore {
	private readonly persistence: TargetSelectionHistoryPersistence
	private readonly maxEntries: number
	private entries: RememberedTargetSelection[] = []
	private loadPromise: Promise<void> | null = null
	private saveChain: Promise<void> = Promise.resolve()

	constructor(persistence: TargetSelectionHistoryPersistence = createChromeStoragePersistence(), options: { maxEntries?: number } = {}) {
		this.persistence = persistence
		this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
	}

	async getByPageUrl(pageUrl: string): Promise<RememberedTargetSelection | null> {
		await this.ensureLoaded()
		const pageKey = normalizeSelectionPageKey(pageUrl)
		return this.entries.find((entry) => entry.pageKey === pageKey) ?? null
	}

	async remember(pageUrl: string, target: SelectionTarget): Promise<RememberedTargetSelection> {
		await this.ensureLoaded()

		const entry = buildRememberedSelection(pageUrl, target)
		this.entries = [entry, ...this.entries.filter((candidate) => candidate.pageKey !== entry.pageKey)].slice(0, this.maxEntries)
		await this.persist()
		return entry
	}

	private async ensureLoaded(): Promise<void> {
		if (!this.loadPromise) {
			this.loadPromise = this.persistence
				.load()
				.then((entries) => {
					this.entries = sanitizeRememberedSelections(entries).slice(0, this.maxEntries)
				})
				.catch((error) => {
					console.error('[TargetSelectionHistoryStore] Failed to load history:', error)
					this.entries = []
				})
		}

		await this.loadPromise
	}

	private async persist(): Promise<void> {
		this.saveChain = this.saveChain
			.catch(() => undefined)
			.then(() => this.persistence.save(this.entries))
			.catch((error) => {
				console.error('[TargetSelectionHistoryStore] Failed to save history:', error)
			})

		await this.saveChain
	}
}

export const createChromeStoragePersistence = (
	storageArea: chrome.storage.StorageArea = chrome.storage.local,
	storageKey: string = DEFAULT_STORAGE_KEY,
): TargetSelectionHistoryPersistence => ({
	load: async () => {
		const stored = await readStorageValue<unknown>(storageArea, storageKey)
		return sanitizeRememberedSelections(Array.isArray(stored) ? stored : [])
	},
	save: async (entries) => {
		await writeStorageValue(storageArea, { [storageKey]: entries })
	},
})

const buildRememberedSelection = (pageUrl: string, target: SelectionTarget): RememberedTargetSelection => {
	const base = {
		pageKey: normalizeSelectionPageKey(pageUrl),
		pageUrl,
		updatedAt: Date.now(),
	}

	if (target.type === 'page') {
		return {
			...base,
			target: { type: 'page' },
		}
	}

	return {
		...base,
		target: {
			type: 'iframe',
			url: normalizeTargetUrl(target.url),
			title: normalizeTargetTitle(target.title),
		},
	}
}

const pickSingleTargetMatch = <T>(targets: T[], predicate: (target: T) => boolean): T | null => {
	const matches = targets.filter(predicate)
	return matches.length === 1 ? matches[0] : null
}

const getIframeTargets = (targets: SelectionTarget[]): Array<SelectionTarget & { type: 'iframe'; frameId: string }> => {
	return targets.filter((target): target is SelectionTarget & { type: 'iframe'; frameId: string } => {
		return target.type === 'iframe' && typeof target.frameId === 'string' && target.frameId.length > 0
	})
}

const sanitizeRememberedSelections = (entries: unknown[]): RememberedTargetSelection[] => {
	return entries
		.map(sanitizeRememberedSelection)
		.filter((entry): entry is RememberedTargetSelection => entry !== null)
		.sort(sortByUpdatedAtDesc)
}

const sanitizeRememberedSelection = (entry: unknown): RememberedTargetSelection | null => {
	const candidate = entry as RememberedSelectionDraft
	if (typeof candidate?.pageUrl !== 'string' || candidate.pageUrl.length === 0) {
		return null
	}

	const base = {
		pageKey:
			typeof candidate.pageKey === 'string' && candidate.pageKey.length > 0 ? candidate.pageKey : normalizeSelectionPageKey(candidate.pageUrl),
		pageUrl: candidate.pageUrl,
		updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : 0,
	}

	if (candidate.target?.type === 'page') {
		return {
			...base,
			target: { type: 'page' },
		}
	}

	if (candidate.target?.type !== 'iframe') {
		return null
	}

	return {
		...base,
		target: {
			type: 'iframe',
			url: normalizeTargetUrl(typeof candidate.target.url === 'string' ? candidate.target.url : null),
			title: normalizeTargetTitle(typeof candidate.target.title === 'string' ? candidate.target.title : null),
		},
	}
}

function normalizeTargetUrl(url: string | null | undefined): string | null {
	return normalizeOptionalText(url)
}

function normalizeTargetTitle(title: string | null | undefined): string | null {
	return normalizeOptionalText(title)
}

function normalizeOptionalText(value: string | null | undefined): string | null {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

const sortByUpdatedAtDesc = (left: RememberedTargetSelection, right: RememberedTargetSelection): number => right.updatedAt - left.updatedAt

const readStorageValue = async <T>(storageArea: chrome.storage.StorageArea, key: string): Promise<T | undefined> => {
	return await new Promise<T | undefined>((resolve, reject) => {
		storageArea.get(key, (items) => {
			const error = chrome.runtime.lastError
			if (error) {
				reject(new Error(error.message))
				return
			}
			resolve(items[key] as T | undefined)
		})
	})
}

const writeStorageValue = async (storageArea: chrome.storage.StorageArea, items: Record<string, unknown>): Promise<void> => {
	await new Promise<void>((resolve, reject) => {
		storageArea.set(items, () => {
			const error = chrome.runtime.lastError
			if (error) {
				reject(new Error(error.message))
				return
			}
			resolve()
		})
	})
}
