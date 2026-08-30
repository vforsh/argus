import { normalizeSelectionPageKey, type SelectionTarget } from './target-selection-history.js'
import { PageKeyedStore, createChromeStorePersistence, normalizeOptionalText, sortByUpdatedAtDesc } from './page-keyed-store.js'

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
export class TargetVisibilityHistoryStore extends PageKeyedStore<HiddenTargetPageEntry> {
	constructor(persistence: TargetVisibilityPersistence = createChromeStoragePersistence(), options: { maxPageEntries?: number } = {}) {
		super(persistence, options.maxPageEntries ?? DEFAULT_MAX_PAGE_ENTRIES, 'TargetVisibilityHistoryStore')
	}

	async getHiddenTargets(pageUrl: string): Promise<HiddenTarget[]> {
		await this.ensureLoaded()
		return [...(this.findByPageKey(normalizeSelectionPageKey(pageUrl))?.targets ?? [])]
	}

	async hide(pageUrl: string, target: SelectionTarget): Promise<HiddenTargetPageEntry | null> {
		await this.ensureLoaded()
		const hiddenTarget = toHiddenTarget(target)
		if (!hiddenTarget) {
			return null
		}

		const pageKey = normalizeSelectionPageKey(pageUrl)
		const existing = this.findByPageKey(normalizeSelectionPageKey(pageUrl))
		const targets = uniqueHiddenTargets([hiddenTarget, ...(existing?.targets ?? [])])
		const entry = { pageKey, pageUrl, updatedAt: Date.now(), targets }
		this.upsert(entry)
		await this.persist()
		return entry
	}

	async show(pageUrl: string, target: SelectionTarget): Promise<void> {
		await this.ensureLoaded()
		const hiddenTarget = toHiddenTarget(target)
		if (!hiddenTarget) {
			return
		}

		const existing = this.findByPageKey(normalizeSelectionPageKey(pageUrl))
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
}

export const createChromeStoragePersistence = (
	storageArea: chrome.storage.StorageArea = chrome.storage.local,
	storageKey: string = DEFAULT_STORAGE_KEY,
): TargetVisibilityPersistence =>
	createChromeStorePersistence(storageKey, (value) => sanitizeHiddenTargetEntries(Array.isArray(value) ? value : []), storageArea)

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
