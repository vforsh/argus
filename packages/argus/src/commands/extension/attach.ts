import type { ErrorResponse, ExtensionBrowserTab, ExtensionTabsResponse, WatcherRecord } from '@vforsh/argus-core'
import { createOutput } from '../../output/io.js'
import { formatWatcherLine } from '../../output/format.js'
import { fetchWatcherJson } from '../../watchers/requestWatcher.js'
import { resolveExtensionWatcher } from './resolveExtensionWatcher.js'

export type ExtensionAttachOptions = ExtensionTabActionOptions
export type ExtensionDetachOptions = ExtensionTabActionOptions

type ExtensionTabActionOptions = {
	tab?: string | number
	url?: string
	title?: string
	json?: boolean
}

type ExtensionTabAction = 'attach' | 'detach'

type TabSelector = { kind: 'tab'; tabId: number } | { kind: 'query'; url?: string; title?: string }

type ActionResponse = {
	ok: true
	message?: string
}

export const runExtensionAttach = async (options: ExtensionAttachOptions): Promise<void> => {
	await runExtensionTabAction('attach', options)
}

export const runExtensionDetach = async (options: ExtensionDetachOptions): Promise<void> => {
	await runExtensionTabAction('detach', options)
}

const runExtensionTabAction = async (action: ExtensionTabAction, options: ExtensionTabActionOptions): Promise<void> => {
	const output = createOutput(options)
	const resolved = await resolveExtensionWatcher({})
	if (!resolved.ok) {
		writeResolveFailure(output, options, resolved)
		return
	}

	const selector = parseTabSelector(options)
	if (!selector.ok) {
		writeTabResolutionFailure(output, options, selector)
		return
	}

	const tabs = await fetchTabs(resolved.watcher, selector.selector, output, options)
	if (!tabs) {
		return
	}

	const tab = resolveTab(tabs, selector.selector)
	if (!tab.ok) {
		writeTabResolutionFailure(output, options, tab)
		return
	}

	let response: ActionResponse | ErrorResponse
	try {
		response = await fetchWatcherJson<ActionResponse | ErrorResponse>(resolved.watcher, {
			path: action === 'attach' ? '/attach' : '/detach',
			method: 'POST',
			body: { tabId: tab.tab.tabId },
			timeoutMs: 5_000,
			returnErrorResponse: true,
		})
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		writeCommandError(output, options, `${resolved.watcher.id}: failed to ${action} tab (${message})`, message)
		return
	}

	if (!response.ok) {
		writeCommandError(output, options, `Error: ${response.error.message}`, response)
		return
	}

	if (options.json) {
		output.writeJson({
			ok: true,
			tab: tab.tab,
			watcherId: resolved.watcher.id,
		})
		return
	}

	const verb = action === 'attach' ? 'Attach' : 'Detach'
	output.writeHuman(`${verb} request sent via ${resolved.watcher.id}`)
	output.writeHuman(`  ${formatExtensionTabLine(tab.tab)}`)
}

const fetchTabs = async (
	watcher: WatcherRecord,
	selector: TabSelector,
	output: ReturnType<typeof createOutput>,
	options: ExtensionTabActionOptions,
): Promise<ExtensionBrowserTab[] | null> => {
	const query = buildTabsQuery(selector)

	try {
		const response = await fetchWatcherJson<ExtensionTabsResponse | ErrorResponse>(watcher, {
			path: '/tabs',
			query,
			timeoutMs: 5_000,
			returnErrorResponse: true,
		})
		if (!response.ok) {
			writeCommandError(output, options, `Error: ${response.error.message}`, response)
			return null
		}
		return response.tabs
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		writeCommandError(output, options, `${watcher.id}: failed to list extension tabs (${message})`, message)
		return null
	}
}

type TabResolutionResult = { ok: true; tab: ExtensionBrowserTab } | { ok: false; reason: string; exitCode: 1 | 2; matches?: ExtensionBrowserTab[] }

type SelectorResult = { ok: true; selector: TabSelector } | { ok: false; reason: string; exitCode: 2 }
type TabActionFailure = Exclude<TabResolutionResult, { ok: true }> | Exclude<SelectorResult, { ok: true }>

const parseTabSelector = (options: ExtensionTabActionOptions): SelectorResult => {
	const tabId = parseTabId(options.tab)
	const url = options.url?.trim()
	const title = options.title?.trim()

	if (tabId !== null && (url || title)) {
		return { ok: false, reason: 'Use --tab by itself, or resolve by --url/--title.', exitCode: 2 }
	}
	if (tabId === null && !url && !title) {
		return { ok: false, reason: 'Specify --tab <tabId>, --url <substring>, or --title <substring>.', exitCode: 2 }
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

const writeTabResolutionFailure = (output: ReturnType<typeof createOutput>, options: ExtensionTabActionOptions, result: TabActionFailure): void => {
	const matches = 'matches' in result ? result.matches : undefined
	if (options.json) {
		output.writeJson({ ok: false, error: result.reason, matches: matches ?? [] })
	} else {
		output.writeWarn(result.reason)
		if (matches) {
			for (const tab of matches) {
				output.writeWarn(`  ${formatExtensionTabLine(tab)}`)
			}
		}
	}
	process.exitCode = result.exitCode
}

const writeResolveFailure = (
	output: ReturnType<typeof createOutput>,
	options: ExtensionTabActionOptions,
	resolved: Exclude<Awaited<ReturnType<typeof resolveExtensionWatcher>>, { ok: true }>,
): void => {
	if (options.json) {
		output.writeJson({ ok: false, error: resolved.error, candidates: resolved.candidates?.map((watcher) => watcher.id) ?? [] })
	} else {
		output.writeWarn(resolved.error)
		if (resolved.candidates && resolved.candidates.length > 0) {
			for (const watcher of resolved.candidates) {
				output.writeWarn(formatWatcherLine(watcher))
			}
		}
	}
	process.exitCode = resolved.exitCode
}

const writeCommandError = (
	output: ReturnType<typeof createOutput>,
	options: ExtensionTabActionOptions,
	humanMessage: string,
	jsonPayload: string | ErrorResponse,
): void => {
	if (options.json) {
		output.writeJson(typeof jsonPayload === 'string' ? { ok: false, error: jsonPayload } : jsonPayload)
	} else {
		output.writeWarn(humanMessage)
	}
	process.exitCode = 1
}

const formatExtensionTabLine = (tab: ExtensionBrowserTab): string => {
	const state = tab.attached ? 'attached' : 'available'
	const label = tab.title || '(untitled)'
	return `${tab.tabId} [${state}] ${label} - ${tab.url}`
}
