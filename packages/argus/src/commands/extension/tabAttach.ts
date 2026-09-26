import { formatError } from '../../cli/parse.js'
import type { ExtensionBrowserTab, ExtensionTabActionResponse, StatusResponse, WatcherRecord, ApiResult } from '@vforsh/argus-core'
import { fetchWatcherJson } from '../../watchers/requestWatcher.js'
import { resolveWatcher } from '../../watchers/resolveWatcher.js'
import { fetchExtensionTabs, resolveTab, type TabSelector } from './tabSelection.js'
import { delay } from '@vforsh/argus-core'

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
		const response = await fetchWatcherJson<ApiResult<ExtensionTabActionResponse>>(controlWatcher, {
			path: '/attach',
			method: 'POST',
			body: { tabId: tab.tabId, watcherId: options.watcherId },
			timeoutMs: 18_000,
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
	let lastReason = `Tab ${tab.tabId} has not reported an attached watcher through ${controlWatcher.id}.`

	while (Date.now() - startedAt <= WATCHER_POLL_TIMEOUT_MS) {
		const latestTab = await refreshTab(controlWatcher, selector, tab)
		if (latestTab && !latestTab.attached) {
			lastReason = `Tab ${tab.tabId} detached before its watcher became ready.`
			break
		}
		const explicitWatcherId = latestTab?.watcherId ?? watcherId
		if (explicitWatcherId) {
			const watcher = await resolveWatcherById(explicitWatcherId)
			if (watcher) {
				const status = await fetchStatus(watcher)
				if (status && statusMatchesTabWatcher(status, latestTab ?? tab, latestTab?.watcherId === explicitWatcherId)) {
					return { ok: true, watcher, status, tab: latestTab ?? tab }
				}
			}
			lastReason = `Watcher ${explicitWatcherId} did not become debugger-attached for tab ${tab.tabId}.`
		}

		await delay(WATCHER_POLL_INTERVAL_MS)
	}

	return { ok: false, reason: lastReason, exitCode: 1 }
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
	return tab.ok ? tab.tab : null
}

const resolveWatcherById = async (id: string): Promise<WatcherRecord | null> => {
	const resolved = await resolveWatcher({ id })
	return resolved.ok && resolved.watcher.source === 'extension' ? resolved.watcher : null
}

const fetchStatus = async (watcher: WatcherRecord): Promise<StatusResponse | null> => {
	try {
		return await fetchWatcherJson<StatusResponse>(watcher, { path: '/status', timeoutMs: 1_000 })
	} catch {
		return null
	}
}

const statusMatchesTabWatcher = (status: StatusResponse | null, tab: ExtensionBrowserTab, tabListConfirmsWatcher: boolean): boolean => {
	if (!status?.attached || !status.target || status.targetReady === false) {
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
