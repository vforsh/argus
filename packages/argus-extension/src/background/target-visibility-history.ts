import { normalizeSelectionPageKey, type SelectionTarget } from './target-selection-history.js'

export type HiddenTarget = {
	type: 'iframe'
	url: string | null
	title: string | null
}

export type HiddenTargetPageEntry = {
	pageKey: string
	pageUrl: string
	updatedAt: number
	targets: HiddenTarget[]
}

export type TargetVisibilityPersistence = {
	load: () => Promise<HiddenTargetPageEntry[]>
	save: (entries: HiddenTargetPageEntry[]) => Promise<void>
}

type HiddenTargetPageDraft = Partial<HiddenTargetPageEntry> & {
	targets?: unknown
}

type HiddenTargetDraft = Partial<HiddenTarget> & {
	type?: unknown
	url?: unknown
	title?: unknown
}

const DEFAULT_STORAGE_KEY = 'hiddenTargetHistory'
const DEFAULT_MAX_PAGE_ENTRIES = 20

/**
 * Persists page-scoped iframe hide preferences. Frame ids are intentionally not stored:
 * Chrome regenerates them often, while URL/title signatures survive reloads well enough.
 */
export class TargetVisibilityHistoryStore {
	private readonly persistence: TargetVisibilityPersistence
	private readonly maxPageEntries: number
	private entries: HiddenTargetPageEntry[] = []
	private loadPromise: Promise<void> | null = null
	private saveChain: Promise<void> = Promise.resolve()

	constructor(persistence: TargetVisibilityPersistence = createChromeStoragePersistence(), options: { maxPageEntries?: number } = {}) {
		this.persistence = persistence
		this.maxPageEntries = options.maxPageEntries ?? DEFAULT_MAX_PAGE_ENTRIES
	}

	async getHiddenTargets(pageUrl: string): Promise<HiddenTarget[]> {
		await this.ensureLoaded()
		return [...(this.findEntry(pageUrl)?.targets ?? [])]
	}

	async hide(pageUrl: string, target: SelectionTarget): Promise<HiddenTargetPageEntry | null> {
		await this.ensureLoaded()
		const hiddenTarget = toHiddenTarget(target)
		if (!hiddenTarget) {
			return null
		}

		const pageKey = normalizeSelectionPageKey(pageUrl)
		const existing = this.findEntry(pageUrl)
		const targets = uniqueHiddenTargets([hiddenTarget, ...(existing?.targets ?? [])])
		const entry = { pageKey, pageUrl, updatedAt: Date.now(), targets }
		this.upsertEntry(entry)
		await this.persist()
		return entry
	}

	async show(pageUrl: string, target: SelectionTarget): Promise<void> {
		await this.ensureLoaded()
		const hiddenTarget = toHiddenTarget(target)
		if (!hiddenTarget) {
			return
		}

		const existing = this.findEntry(pageUrl)
		if (!existing) {
			return
		}

		const targets = existing.targets.filter((candidate) => !isSameHiddenTarget(candidate, hiddenTarget))
		if (targets.length === 0) {
			this.entries = this.entries.filter((entry) => entry.pageKey !== existing.pageKey)
			await this.persist()
			return
		}

		this.entries = this.entries.map((entry) => (entry.pageKey === existing.pageKey ? { ...entry, targets, updatedAt: Date.now() } : entry))
		await this.persist()
	}

	async isHidden(pageUrl: string, target: SelectionTarget): Promise<boolean> {
		const hiddenTargets = await this.getHiddenTargets(pageUrl)
		return hiddenTargets.some((hiddenTarget) => matchesHiddenTarget(hiddenTarget, target))
	}

	private findEntry(pageUrl: string): HiddenTargetPageEntry | null {
		const pageKey = normalizeSelectionPageKey(pageUrl)
		return this.entries.find((entry) => entry.pageKey === pageKey) ?? null
	}

	private upsertEntry(entry: HiddenTargetPageEntry): void {
		this.entries = [entry, ...this.entries.filter((candidate) => candidate.pageKey !== entry.pageKey)].slice(0, this.maxPageEntries)
	}

	private async ensureLoaded(): Promise<void> {
		if (!this.loadPromise) {
			this.loadPromise = this.persistence
				.load()
				.then((entries) => {
					this.entries = sanitizeHiddenTargetEntries(entries).slice(0, this.maxPageEntries)
				})
				.catch((error) => {
					console.error('[TargetVisibilityHistoryStore] Failed to load history:', error)
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
				console.error('[TargetVisibilityHistoryStore] Failed to save history:', error)
			})

		await this.saveChain
	}
}

export const createChromeStoragePersistence = (
	storageArea: chrome.storage.StorageArea = chrome.storage.local,
	storageKey: string = DEFAULT_STORAGE_KEY,
): TargetVisibilityPersistence => ({
	load: async () => {
		const stored = await readStorageValue<unknown>(storageArea, storageKey)
		return sanitizeHiddenTargetEntries(Array.isArray(stored) ? stored : [])
	},
	save: async (entries) => {
		await writeStorageValue(storageArea, { [storageKey]: entries })
	},
})

export function matchesHiddenTarget(hiddenTarget: HiddenTarget, target: SelectionTarget): boolean {
	if (target.type !== 'iframe') {
		return false
	}

	const candidate = toHiddenTarget(target)
	return candidate ? isSameHiddenTarget(hiddenTarget, candidate) : false
}

function toHiddenTarget(target: SelectionTarget): HiddenTarget | null {
	if (target.type !== 'iframe') {
		return null
	}

	const url = normalizeOptionalText(target.url)
	const title = normalizeOptionalText(target.title)
	if (!url && !title) {
		return null
	}

	return { type: 'iframe', url, title }
}

function uniqueHiddenTargets(targets: HiddenTarget[]): HiddenTarget[] {
	const unique: HiddenTarget[] = []
	for (const target of targets) {
		if (!unique.some((candidate) => isSameHiddenTarget(candidate, target))) {
			unique.push(target)
		}
	}
	return unique
}

function isSameHiddenTarget(left: HiddenTarget, right: HiddenTarget): boolean {
	if (left.url || right.url) {
		return left.url === right.url
	}

	return left.title === right.title
}

function sanitizeHiddenTargetEntries(entries: unknown[]): HiddenTargetPageEntry[] {
	return entries
		.map(sanitizeHiddenTargetEntry)
		.filter((entry): entry is HiddenTargetPageEntry => entry !== null)
		.sort(sortByUpdatedAtDesc)
}

function sanitizeHiddenTargetEntry(entry: unknown): HiddenTargetPageEntry | null {
	const candidate = entry as HiddenTargetPageDraft
	if (typeof candidate?.pageUrl !== 'string' || candidate.pageUrl.length === 0 || !Array.isArray(candidate.targets)) {
		return null
	}

	const targets = uniqueHiddenTargets(candidate.targets.map(sanitizeHiddenTarget).filter((target): target is HiddenTarget => target !== null))
	if (targets.length === 0) {
		return null
	}

	return {
		pageKey:
			typeof candidate.pageKey === 'string' && candidate.pageKey.length > 0 ? candidate.pageKey : normalizeSelectionPageKey(candidate.pageUrl),
		pageUrl: candidate.pageUrl,
		updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : 0,
		targets,
	}
}

function sanitizeHiddenTarget(target: unknown): HiddenTarget | null {
	const candidate = target as HiddenTargetDraft
	if (candidate?.type !== 'iframe') {
		return null
	}

	const url = normalizeOptionalText(typeof candidate.url === 'string' ? candidate.url : null)
	const title = normalizeOptionalText(typeof candidate.title === 'string' ? candidate.title : null)
	if (!url && !title) {
		return null
	}

	return { type: 'iframe', url, title }
}

function normalizeOptionalText(value: string | null | undefined): string | null {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

const sortByUpdatedAtDesc = (left: HiddenTargetPageEntry, right: HiddenTargetPageEntry): number => right.updatedAt - left.updatedAt

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
