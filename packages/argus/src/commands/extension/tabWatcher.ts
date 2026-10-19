import { emitFailure, emitResolveFailure } from './failures.js'
import type { ExtensionBrowserTab, StatusResponse, WatcherRecord } from '@vforsh/argus-core'
import type { Output } from '../../output/io.js'
import { formatBrowserGroupName, resolveControlTabs, type BrowserTabGroup } from './browserTabs.js'
import {
	formatExtensionTabLine,
	hasTabSelector,
	isExactUrlMatch,
	normalizeUrlForExactMatch,
	parseTabPick,
	parseTabSelector,
	resolveTab,
	type SelectorResult,
	type TabResolutionResult,
} from './tabSelection.js'
import { attachTab, openExtensionTab, waitForTabWatcher } from './tabAttach.js'

export type ExtensionTabWatcherOptions = {
	id?: string
	/** Browser label or instance id; alternative to `id`. */
	browser?: string
	tab?: string | number
	url?: string
	title?: string
	/** How to choose among several matching tabs (`newest`, `active`, `first`). */
	pick?: string
	/** Open this URL in a new tab when no existing tab matches, then attach it. */
	open?: string
	as?: string
	json?: boolean
}

export type ExtensionTabWatcherResult = {
	controlWatcher: WatcherRecord
	watcher: WatcherRecord
	tab: ExtensionBrowserTab
	status?: StatusResponse
	/** True when the tab was opened by this call (`--open`). */
	opened?: boolean
}

type TabActionFailure =
	| Exclude<TabResolutionResult, { ok: true }>
	| Exclude<SelectorResult, { ok: true }>
	| Exclude<ReturnType<typeof parseTabPick>, { ok: true }>

export const resolveOrAttachExtensionTabWatcher = async (
	options: ExtensionTabWatcherOptions,
	output: Output,
	config: { missingSelectorReason: string },
): Promise<ExtensionTabWatcherResult | null> => {
	const pick = parseTabPick(options.pick)
	if (!pick.ok) {
		writeTabFailure(output, pick)
		return null
	}

	const openUrl = options.open ? normalizeOpenUrl(options.open) : null
	// `--open <url>` alone reuses a tab already showing that URL before opening another. The
	// extension filters by substring, so it is asked for the scheme-less form; exact-match
	// comparison (ignoring scheme, hash and trailing slash) then decides.
	const reuseOpenUrl = Boolean(openUrl && !hasTabSelector(options))
	const selectorOptions = reuseOpenUrl ? { url: normalizeUrlForExactMatch(openUrl!) } : options
	const selector = parseTabSelector(selectorOptions, config.missingSelectorReason)
	if (!selector.ok) {
		writeTabFailure(output, selector)
		return null
	}

	const resolved = await resolveControlTabs(options, selector.selector, reuseOpenUrl ? { accept: (tab) => isExactUrlMatch(tab.url, openUrl!) } : {})
	if (resolved.kind === 'failed') {
		emitResolveFailure(output, resolved.failure)
		return null
	}
	if (resolved.kind === 'grouped') {
		writeGroupedFailure(output, resolved.groups, openUrl)
		return null
	}
	if (resolved.fetchFailure) {
		emitFailure(output, { error: resolved.fetchFailure.response ?? resolved.fetchFailure.error })
		return null
	}
	for (const warning of resolved.warnings) output.writeWarn(warning)

	const tabSelector = selector.selector
	const candidates = tabSelector.kind === 'tab' ? resolved.tabs.filter((tab) => tab.tabId === tabSelector.tabId) : resolved.tabs
	if (openUrl && candidates.length === 0) {
		const opened = await openExtensionTab(resolved.watcher, openUrl)
		if (!opened.ok) {
			emitFailure(output, { error: opened })
			return null
		}
		const attached = await attachResolvedExtensionTabWatcher(resolved.watcher, opened.tab, options, output)
		return attached ? { ...attached, opened: true } : null
	}

	const tabResult = resolveTab(candidates, tabSelector, { pick: pick.pick })
	if (!tabResult.ok) {
		writeTabFailure(output, tabResult)
		return null
	}

	return attachResolvedExtensionTabWatcher(resolved.watcher, tabResult.tab, options, output)
}

/** Explicit schemes pass through; bare local hosts open as http, anything else as https. */
const normalizeOpenUrl = (value: string): string => {
	const trimmed = value.trim()
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || /^(about|data|blob|javascript):/i.test(trimmed)) {
		return trimmed
	}
	const host = trimmed.replace(/[/?#].*$/, '').replace(/:\d+$/, '').toLowerCase()
	const local = host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
	return `${local ? 'http' : 'https'}://${trimmed}`
}

/** Several browsers matched (or none did and `--open` cannot guess where to open). */
const writeGroupedFailure = (output: Output, groups: BrowserTabGroup[], openUrl: string | null): void => {
	const withTabs = groups.filter((group) => group.tabs.length > 0)
	const names = groups.map(formatBrowserGroupName).join(', ')
	const reason =
		withTabs.length > 1
			? `Matching tabs are open in ${withTabs.length} browsers (${withTabs.map(formatBrowserGroupName).join(', ')}). Pass --id <controlWatcherId> or --browser <label>, or --tab <tabId>.`
			: openUrl
				? `No matching tab in any live browser (${names}). Pass --id <controlWatcherId> or --browser <label> to choose where to open ${openUrl}.`
				: `No extension tab matched in any live browser (${names}).`
	const hints = groups.flatMap((group) =>
		group.error
			? [`${formatBrowserGroupName(group)}: could not list tabs (${group.error})`]
			: group.tabs.length > 0
				? [`${formatBrowserGroupName(group)}:`, ...group.tabs.map((tab) => `  ${formatExtensionTabLine(tab)}`)]
				: [],
	)
	emitFailure(output, {
		error: reason,
		code: withTabs.length > 1 ? 'ambiguous_control' : undefined,
		exitCode: 2,
		hints,
		details: {
			matches: withTabs.flatMap((group) => group.tabs.map((tab) => ({ ...tab, controlId: group.control.id, browserLabel: group.label }))),
			browsers: groups.map((group) => ({ controlId: group.control.id, label: group.label, tabCount: group.tabs.length, error: group.error })),
		},
	})
}

/** Attach/reuse an already resolved control and tab without re-resolving their names or selectors. */
export const attachResolvedExtensionTabWatcher = async (
	controlWatcher: WatcherRecord,
	tab: ExtensionBrowserTab,
	options: Pick<ExtensionTabWatcherOptions, 'as' | 'json'>,
	output: Output,
): Promise<ExtensionTabWatcherResult | null> => {
	if (options.as && tab.attached && tab.watcherId && tab.watcherId !== options.as) {
		writeFailure(output, options, `Tab ${tab.tabId} is already attached as ${tab.watcherId}. Detach it before re-attaching as ${options.as}.`, 2)
		return null
	}

	const activeTab = tab.attached
		? { ok: true as const, tab, watcherId: tab.watcherId }
		: await attachTab(controlWatcher, tab, { watcherId: options.as })
	if (!activeTab.ok) {
		emitFailure(output, { error: activeTab })
		return null
	}

	const watcher = await waitForTabWatcher(
		controlWatcher,
		{ kind: 'tab', tabId: activeTab.tab.tabId },
		{ ...activeTab.tab, attached: true },
		activeTab.watcherId ?? options.as,
	)
	if (!watcher.ok) {
		emitFailure(output, { error: watcher.error ?? watcher.reason, exitCode: watcher.exitCode })
		return null
	}

	return {
		controlWatcher,
		watcher: watcher.watcher,
		tab: watcher.tab,
		status: watcher.status,
	}
}

const writeTabFailure = (output: Output, result: TabActionFailure): void => {
	const matches = 'matches' in result ? (result.matches ?? []) : []
	emitFailure(output, {
		error: result.reason,
		exitCode: result.exitCode,
		hints: matches.map((tab) => `  ${formatExtensionTabLine(tab)}`),
		details: { matches },
	})
}

/**
 * Report a tab-watcher failure.
 *
 * Kept as a named export because several sibling commands call it; the body is now just
 * the shared emitter, so all of them produce the canonical envelope.
 */
export const writeFailure = (output: Output, _options: { json?: boolean }, error: string, exitCode: 1 | 2): void => {
	emitFailure(output, { error, exitCode })
}
