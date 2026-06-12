import type { ErrorResponse, ExtensionBrowserTab, ExtensionTabActionResponse, StatusResponse, WatcherRecord } from '@vforsh/argus-core'
import { pruneRegistry } from '../../registry.js'
import { fetchWatcherJson } from '../../watchers/requestWatcher.js'
import { resolveWatcher } from '../../watchers/resolveWatcher.js'
import { fetchExtensionTabs, resolveTab, type TabSelector } from './tabSelection.js'

export type WatcherResolutionResult =
	| { ok: true; watcher: WatcherRecord; tab: ExtensionBrowserTab; status?: StatusResponse }
	| { ok: false; reason: string; exitCode: 1 | 2; matches?: Array<{ watcher: WatcherRecord; status: StatusResponse }> }

const WATCHER_POLL_TIMEOUT_MS = 5_000
const WATCHER_POLL_INTERVAL_MS = 200

export const attachTab = async (
	controlWatcher: WatcherRecord,
	tab: ExtensionBrowserTab,
	options: { watcherId?: string } = {},
): Promise<{ ok: true; tab: ExtensionBrowserTab; watcherId?: string } | { ok: false; error: string }> => {
	try {
		const response = await fetchWatcherJson<ExtensionTabActionResponse | ErrorResponse>(controlWatcher, {
			path: '/attach',
			method: 'POST',
			body: { tabId: tab.tabId, watcherId: options.watcherId },
			timeoutMs: 5_000,
			returnErrorResponse: true,
		})
		if (!response.ok) {
			return { ok: false, error: `Error: ${response.error.message}` }
		}
		return { ok: true, tab: response.tab, watcherId: response.watcherId }
	} catch (error) {
		return { ok: false, error: `${controlWatcher.id}: failed to attach tab (${formatError(error)})` }
	}
}

export const waitForTabWatcher = async (
	controlWatcher: WatcherRecord,
	selector: TabSelector,
	tab: ExtensionBrowserTab,
	watcherId?: string,
): Promise<WatcherResolutionResult> => {
	const startedAt = Date.now()
	let lastResult: WatcherResolutionResult = { ok: false, reason: 'No extension watcher matched the tab.', exitCode: 1 }

	while (Date.now() - startedAt <= WATCHER_POLL_TIMEOUT_MS) {
		const latestTab = await refreshTab(controlWatcher, selector, tab)
		const explicitWatcherId = latestTab?.watcherId ?? watcherId
		if (explicitWatcherId) {
			// Fresh extension attaches report their tab-scoped watcher id asynchronously through `ext tabs`.
			const watcher = await resolveWatcherById(explicitWatcherId)
			if (watcher) {
				const status = await fetchStatus(watcher)
				if (!status || !statusMatchesTabWatcher(status, latestTab ?? tab, latestTab?.watcherId === explicitWatcherId)) {
					await delay(WATCHER_POLL_INTERVAL_MS)
					continue
				}
				return { ok: true, watcher, status, tab: latestTab ?? tab }
			}
		}

		lastResult = await resolveTabWatcher(latestTab ?? tab)
		if (lastResult.ok) {
			return lastResult
		}

		await delay(WATCHER_POLL_INTERVAL_MS)
	}

	return lastResult
}

const refreshTab = async (
	controlWatcher: WatcherRecord,
	selector: TabSelector,
	fallback: ExtensionBrowserTab,
): Promise<ExtensionBrowserTab | null> => {
	const tabs = await fetchExtensionTabs(controlWatcher, selector)
	if (!tabs.ok) {
		return null
	}

	const tab = resolveTab(tabs.tabs, { kind: 'tab', tabId: fallback.tabId })
	return tab.ok ? { ...tab.tab, attached: true } : null
}

const resolveWatcherById = async (id: string): Promise<WatcherRecord | null> => {
	const resolved = await resolveWatcher({ id })
	return resolved.ok && resolved.watcher.source === 'extension' ? resolved.watcher : null
}

const resolveTabWatcher = async (tab: ExtensionBrowserTab): Promise<WatcherResolutionResult> => {
	const registry = await pruneRegistry()
	const extensionWatchers = Object.values(registry.watchers).filter(
		(watcher) => watcher.source === 'extension' && watcher.id !== 'extension-control',
	)

	const entries = await Promise.all(
		extensionWatchers.map(async (watcher) => {
			const status = await fetchStatus(watcher)
			return status ? { watcher, status } : null
		}),
	)

	const matches = entries.filter((entry): entry is { watcher: WatcherRecord; status: StatusResponse } =>
		Boolean(entry?.status.attached && entry.status.target && targetMatchesTab(entry.status.target, tab)),
	)

	if (matches.length === 0) {
		return { ok: false, reason: 'No attached extension watcher matched the tab.', exitCode: 1 }
	}
	if (matches.length > 1) {
		return { ok: false, reason: 'Multiple attached extension watchers matched the tab. Use watcher id instead.', exitCode: 2, matches }
	}
	return { ok: true, watcher: matches[0].watcher, status: matches[0].status, tab }
}

const fetchStatus = async (watcher: WatcherRecord): Promise<StatusResponse | null> => {
	try {
		return await fetchWatcherJson<StatusResponse>(watcher, { path: '/status', timeoutMs: 1_000 })
	} catch {
		return null
	}
}

const statusMatchesTabWatcher = (status: StatusResponse, tab: ExtensionBrowserTab, tabListConfirmsWatcher: boolean): boolean => {
	if (!status.attached || !status.target) {
		return false
	}
	// After target selection, /status may describe an iframe while the tab list
	// still provides the authoritative tab -> watcher mapping.
	return tabListConfirmsWatcher || targetMatchesTab(status.target, tab)
}

const targetMatchesTab = (target: NonNullable<StatusResponse['target']>, tab: ExtensionBrowserTab): boolean => {
	if (target.parentId === `tab:${tab.tabId}`) {
		return true
	}
	if (target.url && target.url === tab.url) {
		return true
	}
	return Boolean(target.title && target.title === tab.title && target.url === tab.url)
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const formatError = (error: unknown): string => (error instanceof Error ? error.message : String(error))
