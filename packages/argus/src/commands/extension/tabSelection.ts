import type { ErrorResponse, ExtensionBrowserTab, ExtensionTabsResponse, WatcherRecord } from '@vforsh/argus-core'
import { fetchWatcherJson } from '../../watchers/requestWatcher.js'

export type ExtensionTabSelectorOptions = {
	tab?: string | number
	url?: string
	title?: string
}

export type TabSelector = { kind: 'tab'; tabId: number } | { kind: 'query'; url?: string; title?: string }

export type SelectorResult = { ok: true; selector: TabSelector } | { ok: false; reason: string; exitCode: 2 }

export type TabResolutionResult = { ok: true; tab: ExtensionBrowserTab } | { ok: false; reason: string; exitCode: 2; matches?: ExtensionBrowserTab[] }

export type ExtensionTabsFetchResult = { ok: true; tabs: ExtensionBrowserTab[] } | { ok: false; error: string }

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

export const resolveTab = (tabs: ExtensionBrowserTab[], selector: TabSelector): TabResolutionResult => {
	const matches = selector.kind === 'tab' ? tabs.filter((tab) => tab.tabId === selector.tabId) : tabs
	if (matches.length === 0) {
		return { ok: false, reason: 'No extension tab matched.', exitCode: 2 }
	}
	if (matches.length > 1) {
		return { ok: false, reason: 'Multiple extension tabs matched. Use --tab to pick one.', exitCode: 2, matches }
	}
	return { ok: true, tab: matches[0] }
}

export const fetchExtensionTabs = async (watcher: WatcherRecord, selector: TabSelector): Promise<ExtensionTabsFetchResult> => {
	const query = buildTabsQuery(selector)

	try {
		const response = await fetchWatcherJson<ExtensionTabsResponse | ErrorResponse>(watcher, {
			path: '/tabs',
			query,
			timeoutMs: 5_000,
			returnErrorResponse: true,
		})
		if (!response.ok) {
			return { ok: false, error: `Error: ${response.error.message}` }
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
	const state = tab.attached ? 'attached' : 'available'
	const label = tab.title || '(untitled)'
	return `${tab.tabId} [${state}] ${label} - ${tab.url}`
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

const formatError = (error: unknown): string => (error instanceof Error ? error.message : String(error))
