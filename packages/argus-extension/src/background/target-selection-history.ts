import { PageKeyedStore, createChromeStorePersistence, sortByUpdatedAtDesc } from './page-keyed-store.js'
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

/** Remembers which target the user last selected on each page. */
export class TargetSelectionHistoryStore extends PageKeyedStore<RememberedTargetSelection> {
	constructor(persistence: TargetSelectionHistoryPersistence = createChromeStoragePersistence(), options: { maxEntries?: number } = {}) {
		super(persistence, options.maxEntries ?? DEFAULT_MAX_ENTRIES, 'TargetSelectionHistoryStore')
	}

	async getByPageUrl(pageUrl: string): Promise<RememberedTargetSelection | null> {
		await this.ensureLoaded()
		return this.findByPageKey(normalizeSelectionPageKey(pageUrl))
	}

	async remember(pageUrl: string, target: SelectionTarget): Promise<RememberedTargetSelection> {
		await this.ensureLoaded()

		const entry = buildRememberedSelection(pageUrl, target)
		this.upsert(entry)
		await this.persist()
		return entry
	}
}

export const createChromeStoragePersistence = (
	storageArea: chrome.storage.StorageArea = chrome.storage.local,
	storageKey: string = DEFAULT_STORAGE_KEY,
): TargetSelectionHistoryPersistence =>
	createChromeStorePersistence(storageKey, (value) => sanitizeRememberedSelections(Array.isArray(value) ? value : []), storageArea)

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
