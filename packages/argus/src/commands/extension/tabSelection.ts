import { formatError } from '../../cli/parse.js'
import type { ExtensionBrowserTab, ExtensionTabsResponse, WatcherRecord, ApiResult, ErrorResponse } from '@vforsh/argus-core'
import { fetchWatcherJson } from '../../watchers/requestWatcher.js'

export type ExtensionTabSelectorOptions = {
	tab?: string | number
	url?: string
	title?: string
}

export type TabSelector = { kind: 'tab'; tabId: number } | { kind: 'query'; url?: string; title?: string }

export type SelectorResult = { ok: true; selector: TabSelector } | { ok: false; reason: string; exitCode: 2 }

export type TabResolutionResult = { ok: true; tab: ExtensionBrowserTab } | { ok: false; reason: string; exitCode: 2; matches?: ExtensionBrowserTab[] }

export type ExtensionTabsFetchResult =
	| { ok: true; tabs: ExtensionBrowserTab[] }
	/** `response` is the watcher's own error envelope (message + code), when it answered with one. */
	| { ok: false; error: string; response?: ErrorResponse }

export const parseTabSelector = (options: ExtensionTabSelectorOptions, missingReason: string): SelectorResult => {
	const tabId = parseTabId(options.tab)
	const url = options.url?.trim()
	const title = options.title?.trim()

	if (tabId !== null && (url || title)) {
		return { ok: false, reason: 'Use --tab by itself, or resolve by --url/--title.', exitCode: 2 }
	}
	if (tabId === null && !url && !title) {
		return { ok: false, reason: missingReason, exitCode: 2 }
	}
	if (options.tab != null && tabId === null) {
		return { ok: false, reason: `Invalid --tab value: ${options.tab}`, exitCode: 2 }
	}

	if (tabId !== null) {
		return { ok: true, selector: { kind: 'tab', tabId } }
	}
	return { ok: true, selector: { kind: 'query', url, title } }
}

/** How to choose among several tabs matching `--url`/`--title`. */
export const TAB_PICK_STRATEGIES = ['newest', 'active', 'first'] as const
export type TabPickStrategy = (typeof TAB_PICK_STRATEGIES)[number]

export const parseTabPick = (value: string | undefined): { ok: true; pick?: TabPickStrategy } | { ok: false; reason: string; exitCode: 2 } => {
	if (value == null) return { ok: true }
	const pick = value.trim().toLowerCase()
	return (TAB_PICK_STRATEGIES as readonly string[]).includes(pick)
		? { ok: true, pick: pick as TabPickStrategy }
		: { ok: false, reason: `Invalid --pick value: ${value}. Expected ${TAB_PICK_STRATEGIES.join(', ')}.`, exitCode: 2 }
}

/**
 * Narrow `tabs` (already filtered by the extension for query selectors) to one.
 *
 * Several matches resolve without help when exactly one tab's URL equals the `--url` pattern
 * (ignoring scheme, trailing slash and hash): `--url client-logs.stark.games/admin/logs` means that
 * page, not every page below it. Otherwise `pick` chooses, or the result lists the matches.
 */
export const resolveTab = (tabs: ExtensionBrowserTab[], selector: TabSelector, options: { pick?: TabPickStrategy } = {}): TabResolutionResult => {
	const matches = selector.kind === 'tab' ? tabs.filter((tab) => tab.tabId === selector.tabId) : tabs
	if (matches.length === 0) {
		return { ok: false, reason: 'No extension tab matched.', exitCode: 2 }
	}
	if (matches.length === 1) {
		return { ok: true, tab: matches[0] }
	}

	const exact = selector.kind === 'query' && selector.url ? matches.filter((tab) => isExactUrlMatch(tab.url, selector.url!)) : []
	if (exact.length === 1) {
		return { ok: true, tab: exact[0] }
	}

	if (options.pick) {
		const picked = pickTab(exact.length > 1 ? exact : matches, options.pick)
		return picked
			? { ok: true, tab: picked }
			: { ok: false, reason: `None of the ${matches.length} matching tabs is active. Use --pick newest or --tab.`, exitCode: 2, matches }
	}
	return {
		ok: false,
		reason: `Multiple extension tabs matched. Use --tab <tabId>, or --pick ${TAB_PICK_STRATEGIES.join('|')}.`,
		exitCode: 2,
		matches,
	}
}

const pickTab = (tabs: ExtensionBrowserTab[], pick: TabPickStrategy): ExtensionBrowserTab | null => {
	if (pick === 'first') return tabs[0] ?? null
	const pool = pick === 'active' ? tabs.filter((tab) => tab.active) : tabs
	// `lastAccessed` comes from newer extensions; tab ids grow monotonically, so they break ties and stand in for it.
	return pool.reduce<ExtensionBrowserTab | null>((best, tab) => (best == null || compareRecency(tab, best) > 0 ? tab : best), null)
}

const compareRecency = (left: ExtensionBrowserTab, right: ExtensionBrowserTab): number =>
	(left.lastAccessed ?? 0) - (right.lastAccessed ?? 0) || left.tabId - right.tabId

/** Drop scheme, hash and trailing slashes; lowercase only the host, since paths are case-sensitive. */
export const normalizeUrlForExactMatch = (value: string): string => {
	const rest = value
		.trim()
		.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
		.replace(/#.*$/, '')
		.replace(/\/+$/, '')
	const slash = rest.search(/[/?]/)
	return slash < 0 ? rest.toLowerCase() : rest.slice(0, slash).toLowerCase() + rest.slice(slash)
}

/** Whether `url` is the page `pattern` names, ignoring scheme, hash and trailing slashes. */
export const isExactUrlMatch = (url: string, pattern: string): boolean => normalizeUrlForExactMatch(url) === normalizeUrlForExactMatch(pattern)

export const fetchExtensionTabs = async (watcher: WatcherRecord, selector: TabSelector): Promise<ExtensionTabsFetchResult> => {
	const query = buildTabsQuery(selector)

	try {
		const response = await fetchWatcherJson<ApiResult<ExtensionTabsResponse>>(watcher, {
			path: '/tabs',
			query,
			timeoutMs: 5_000,
			returnErrorResponse: true,
		})
		if (!response.ok) {
			return { ok: false, error: `Error: ${response.error.message}`, response }
		}
		return { ok: true, tabs: response.tabs }
	} catch (error) {
		return { ok: false, error: `${watcher.id}: failed to list extension tabs (${formatError(error)})` }
	}
}

export const hasTabSelector = (options: ExtensionTabSelectorOptions): boolean => Boolean(options.tab != null || options.url || options.title)

export const isExtensionTab = (value: unknown): value is ExtensionBrowserTab =>
	Boolean(value && typeof value === 'object' && 'tabId' in value && 'url' in value && 'title' in value)

export const formatExtensionTabLine = (tab: ExtensionBrowserTab): string => {
	const state = [tab.attached ? 'attached' : 'available', tab.active ? 'active' : null].filter(Boolean).join(', ')
	const label = tab.title || '(untitled)'
	const watcher = tab.watcherId ? ` as ${tab.watcherId}` : ''
	return `${tab.tabId} [${state}${watcher}] ${label} - ${tab.url}`
}

const parseTabId = (value: string | number | undefined): number | null => {
	if (value === undefined) {
		return null
	}
	const tabId = typeof value === 'number' ? value : Number(value)
	return Number.isInteger(tabId) ? tabId : null
}

const buildTabsQuery = (selector: TabSelector): URLSearchParams => {
	const query = new URLSearchParams()
	if (selector.kind === 'tab') {
		return query
	}
	if (selector.url) {
		query.set('url', selector.url)
	}
	if (selector.title) {
		query.set('title', selector.title)
	}
	return query
}
