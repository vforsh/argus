import { emitFailure, emitResolveFailure } from './failures.js'
import type { ExtensionBrowserTab, StatusResponse, WatcherRecord } from '@vforsh/argus-core'
import type { Output } from '../../output/io.js'
import { resolveExtensionWatcher } from './resolveExtensionWatcher.js'
import {
	fetchExtensionTabs,
	formatExtensionTabLine,
	parseTabSelector,
	resolveTab,
	type SelectorResult,
	type TabResolutionResult,
} from './tabSelection.js'
import { attachTab, waitForTabWatcher } from './tabAttach.js'

export type ExtensionTabWatcherOptions = {
	id?: string
	/** Browser label or instance id; alternative to `id`. */
	browser?: string
	tab?: string | number
	url?: string
	title?: string
	as?: string
	json?: boolean
}

export type ExtensionTabWatcherResult = {
	controlWatcher: WatcherRecord
	watcher: WatcherRecord
	tab: ExtensionBrowserTab
	status?: StatusResponse
}

type TabActionFailure = Exclude<TabResolutionResult, { ok: true }> | Exclude<SelectorResult, { ok: true }>

export const resolveOrAttachExtensionTabWatcher = async (
	options: ExtensionTabWatcherOptions,
	output: Output,
	config: { missingSelectorReason: string },
): Promise<ExtensionTabWatcherResult | null> => {
	const resolved = await resolveExtensionWatcher(options)
	if (!resolved.ok) {
		emitResolveFailure(output, resolved)
		return null
	}

	const selector = parseTabSelector(options, config.missingSelectorReason)
	if (!selector.ok) {
		writeTabFailure(output, selector)
		return null
	}

	const tabs = await fetchExtensionTabs(resolved.watcher, selector.selector)
	if (!tabs.ok) {
		writeFailure(output, options, tabs.error, 1)
		return null
	}

	const tabResult = resolveTab(tabs.tabs, selector.selector)
	if (!tabResult.ok) {
		writeTabFailure(output, tabResult)
		return null
	}

	return attachResolvedExtensionTabWatcher(resolved.watcher, tabResult.tab, options, output)
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
