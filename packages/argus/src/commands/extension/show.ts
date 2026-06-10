import type { ErrorResponse, ExtensionBrowserTab, ExtensionTabsResponse, StatusResponse, VisibilityResponse, WatcherRecord } from '@vforsh/argus-core'
import { createOutput } from '../../output/io.js'
import { pruneRegistry } from '../../registry.js'
import { fetchWatcherJson } from '../../watchers/requestWatcher.js'
import { resolveWatcher } from '../../watchers/resolveWatcher.js'
import { resolveExtensionWatcher } from './resolveExtensionWatcher.js'

export type ExtensionShowOptions = {
	tab?: string | number
	url?: string
	title?: string
	json?: boolean
}

type TabSelector = { kind: 'tab'; tabId: number } | { kind: 'query'; url?: string; title?: string }
type SelectorResult = { ok: true; selector: TabSelector } | { ok: false; reason: string; exitCode: 2 }
type TabResolutionResult = { ok: true; tab: ExtensionBrowserTab } | { ok: false; reason: string; exitCode: 2; matches?: ExtensionBrowserTab[] }
type WatcherResolutionResult =
	| { ok: true; watcher: WatcherRecord; tab: ExtensionBrowserTab; status?: StatusResponse }
	| { ok: false; reason: string; exitCode: 1 | 2; matches?: Array<{ watcher: WatcherRecord; status: StatusResponse }> }
type TabResolutionFailure = Exclude<TabResolutionResult, { ok: true }>
type WatcherResolutionFailure = Exclude<WatcherResolutionResult, { ok: true }>

type ActionResponse = {
	ok: true
	message?: string
}

const WATCHER_POLL_TIMEOUT_MS = 5_000
const WATCHER_POLL_INTERVAL_MS = 200

export const runExtensionShow = async (id: string | undefined, options: ExtensionShowOptions): Promise<void> => {
	const output = createOutput(options)

	if (id && hasTabSelector(options)) {
		writeFailure(output, options, 'Use either watcher id or --tab/--url/--title, not both.', 2)
		return
	}

	if (id) {
		const resolved = await resolveWatcher({ id })
		if (!resolved.ok) {
			writeFailure(output, options, resolved.error, resolved.exitCode)
			return
		}
		if (resolved.watcher.source !== 'extension') {
			writeFailure(output, options, `Watcher ${resolved.watcher.id} is not extension-backed. Use argus page show ${resolved.watcher.id}.`, 2)
			return
		}

		await showWatcher(resolved.watcher, null, output, options)
		return
	}

	const selector = parseTabSelector(options)
	if (!selector.ok) {
		writeFailure(output, options, selector.reason, selector.exitCode)
		return
	}

	const control = await resolveExtensionWatcher({})
	if (!control.ok) {
		writeFailure(output, options, control.error, control.exitCode)
		return
	}

	const tabs = await fetchExtensionTabs(control.watcher, selector.selector)
	if (!tabs.ok) {
		writeFailure(output, options, tabs.error, 1)
		return
	}

	const tabResult = resolveTab(tabs.tabs, selector.selector)
	if (!tabResult.ok) {
		writeTabFailure(output, options, tabResult)
		return
	}

	const tab = tabResult.tab
	if (!tab.attached) {
		const attached = await attachTab(control.watcher, tab)
		if (!attached.ok) {
			writeFailure(output, options, attached.error, 1)
			return
		}
	}

	const watcherResult = await waitForTabWatcher(control.watcher, selector.selector, { ...tab, attached: true })
	if (!watcherResult.ok) {
		writeWatcherFailure(output, options, watcherResult)
		return
	}

	await showWatcher(watcherResult.watcher, watcherResult.tab, output, options)
}

const showWatcher = async (
	watcher: WatcherRecord,
	tab: ExtensionBrowserTab | null,
	output: ReturnType<typeof createOutput>,
	options: ExtensionShowOptions,
): Promise<void> => {
	let response: VisibilityResponse | ErrorResponse
	try {
		response = await fetchWatcherJson<VisibilityResponse | ErrorResponse>(watcher, {
			path: '/visibility',
			method: 'POST',
			body: { action: 'show' },
			timeoutMs: 5_000,
			returnErrorResponse: true,
		})
	} catch (error) {
		writeFailure(output, options, `${watcher.id}: failed to show page (${formatError(error)})`, 1)
		return
	}

	if (!response.ok) {
		writeFailure(output, options, `Error: ${response.error.message}`, 1)
		return
	}

	if (options.json) {
		output.writeJson({
			ok: true,
			watcherId: watcher.id,
			tab,
			visibility: response,
		})
		return
	}

	const suffix = response.attached ? '' : ' (will apply on reattach)'
	output.writeHuman(`shown ${watcher.id}${suffix}`)
	if (tab) {
		output.writeHuman(`  ${formatExtensionTabLine(tab)}`)
	}
}

const attachTab = async (controlWatcher: WatcherRecord, tab: ExtensionBrowserTab): Promise<{ ok: true } | { ok: false; error: string }> => {
	let response: ActionResponse | ErrorResponse
	try {
		response = await fetchWatcherJson<ActionResponse | ErrorResponse>(controlWatcher, {
			path: '/attach',
			method: 'POST',
			body: { tabId: tab.tabId },
			timeoutMs: 5_000,
			returnErrorResponse: true,
		})
	} catch (error) {
		return { ok: false, error: `${controlWatcher.id}: failed to attach tab (${formatError(error)})` }
	}

	if (!response.ok) {
		return { ok: false, error: `Error: ${response.error.message}` }
	}

	return { ok: true }
}

const waitForTabWatcher = async (
	controlWatcher: WatcherRecord,
	selector: TabSelector,
	tab: ExtensionBrowserTab,
): Promise<WatcherResolutionResult> => {
	const startedAt = Date.now()
	let lastResult: WatcherResolutionResult = { ok: false, reason: 'No extension watcher matched the tab.', exitCode: 1 }

	while (Date.now() - startedAt <= WATCHER_POLL_TIMEOUT_MS) {
		const latestTab = await refreshTab(controlWatcher, selector, tab)
		if (latestTab?.watcherId) {
			const watcher = await resolveWatcherById(latestTab.watcherId)
			if (watcher) {
				return { ok: true, watcher, tab: latestTab }
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

const fetchStatus = async (watcher: WatcherRecord): Promise<StatusResponse | null> => {
	try {
		return await fetchWatcherJson<StatusResponse>(watcher, { path: '/status', timeoutMs: 1_000 })
	} catch {
		return null
	}
}

const targetMatchesTab = (target: NonNullable<StatusResponse['target']>, tab: ExtensionBrowserTab): boolean => {
	if (target.url && target.url === tab.url) {
		return true
	}
	return Boolean(target.title && target.title === tab.title && target.url === tab.url)
}

const fetchExtensionTabs = async (
	watcher: WatcherRecord,
	selector: TabSelector,
): Promise<{ ok: true; tabs: ExtensionBrowserTab[] } | { ok: false; error: string }> => {
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

const parseTabSelector = (options: ExtensionShowOptions): SelectorResult => {
	const tabId = parseTabId(options.tab)
	const url = options.url?.trim()
	const title = options.title?.trim()

	if (tabId !== null && (url || title)) {
		return { ok: false, reason: 'Use --tab by itself, or resolve by --url/--title.', exitCode: 2 }
	}
	if (tabId === null && !url && !title) {
		return { ok: false, reason: 'Specify a watcher id, --tab <tabId>, --url <substring>, or --title <substring>.', exitCode: 2 }
	}
	if (options.tab != null && tabId === null) {
		return { ok: false, reason: `Invalid --tab value: ${options.tab}`, exitCode: 2 }
	}

	if (tabId !== null) {
		return { ok: true, selector: { kind: 'tab', tabId } }
	}
	return { ok: true, selector: { kind: 'query', url, title } }
}

const resolveTab = (tabs: ExtensionBrowserTab[], selector: TabSelector): TabResolutionResult => {
	const matches = selector.kind === 'tab' ? tabs.filter((tab) => tab.tabId === selector.tabId) : tabs
	if (matches.length === 0) {
		return { ok: false, reason: 'No extension tab matched.', exitCode: 2 }
	}
	if (matches.length > 1) {
		return { ok: false, reason: 'Multiple extension tabs matched. Use --tab to pick one.', exitCode: 2, matches }
	}
	return { ok: true, tab: matches[0] }
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

const hasTabSelector = (options: ExtensionShowOptions): boolean => Boolean(options.tab != null || options.url || options.title)

const writeTabFailure = (output: ReturnType<typeof createOutput>, options: ExtensionShowOptions, result: TabResolutionFailure): void => {
	writeFailure(output, options, result.reason, result.exitCode, { matches: result.matches ?? [] })
}

const writeWatcherFailure = (output: ReturnType<typeof createOutput>, options: ExtensionShowOptions, result: WatcherResolutionFailure): void => {
	writeFailure(output, options, result.reason, result.exitCode, {
		matches: result.matches?.map((entry) => ({
			watcherId: entry.watcher.id,
			target: entry.status.target,
		})),
	})
}

const writeFailure = (
	output: ReturnType<typeof createOutput>,
	options: ExtensionShowOptions,
	error: string,
	exitCode: 1 | 2,
	extra: Record<string, unknown> = {},
): void => {
	if (options.json) {
		output.writeJson({ ok: false, error, ...extra })
	} else {
		output.writeWarn(error)
		const matches = extra.matches
		if (Array.isArray(matches)) {
			for (const match of matches) {
				if (isExtensionTab(match)) {
					output.writeWarn(`  ${formatExtensionTabLine(match)}`)
				}
			}
		}
	}
	process.exitCode = exitCode
}

const isExtensionTab = (value: unknown): value is ExtensionBrowserTab =>
	Boolean(value && typeof value === 'object' && 'tabId' in value && 'url' in value && 'title' in value)

const formatExtensionTabLine = (tab: ExtensionBrowserTab): string => {
	const state = tab.attached ? 'attached' : 'available'
	const label = tab.title || '(untitled)'
	return `${tab.tabId} [${state}] ${label} - ${tab.url}`
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const formatError = (error: unknown): string => (error instanceof Error ? error.message : String(error))
