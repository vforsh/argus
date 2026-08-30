import { emitFailure } from './failures.js'
import type { ExtensionBrowserTab, StatusResponse, WatcherRecord } from '@vforsh/argus-core'
import type { Output } from '../../output/io.js'
import { formatWatcherLine } from '../../output/format.js'
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
type ActiveTabResult = { ok: true; tab: ExtensionBrowserTab; watcherId?: string } | { ok: false; error: string }

export const resolveOrAttachExtensionTabWatcher = async (
	options: ExtensionTabWatcherOptions,
	output: Output,
	config: { missingSelectorReason: string },
): Promise<ExtensionTabWatcherResult | null> => {
	const resolved = await resolveExtensionWatcher({})
	if (!resolved.ok) {
		writeResolveFailure(output, options, resolved)
		return null
	}

	const selector = parseTabSelector(options, config.missingSelectorReason)
	if (!selector.ok) {
		writeTabFailure(output, options, selector)
		return null
	}

	const tabs = await fetchExtensionTabs(resolved.watcher, selector.selector)
	if (!tabs.ok) {
		writeFailure(output, options, tabs.error, 1)
		return null
	}

	const tabResult = resolveTab(tabs.tabs, selector.selector)
	if (!tabResult.ok) {
		writeTabFailure(output, options, tabResult)
		return null
	}

	const tab = tabResult.tab
	if (options.as && tab.attached && tab.watcherId && tab.watcherId !== options.as) {
		writeFailure(output, options, `Tab ${tab.tabId} is already attached as ${tab.watcherId}. Detach it before re-attaching as ${options.as}.`, 2)
		return null
	}

	const activeTab = await ensureTabAttached(resolved.watcher, tab, options.as)
	if (!activeTab.ok) {
		writeFailure(output, options, activeTab.error, 1)
		return null
	}

	const watcher = await waitForTabWatcher(
		resolved.watcher,
		{ kind: 'tab', tabId: activeTab.tab.tabId },
		{ ...activeTab.tab, attached: true },
		activeTab.watcherId ?? options.as,
	)
	if (!watcher.ok) {
		writeFailure(output, options, watcher.reason, watcher.exitCode)
		return null
	}

	return {
		controlWatcher: resolved.watcher,
		watcher: watcher.watcher,
		tab: watcher.tab,
		status: watcher.status,
	}
}

const ensureTabAttached = async (controlWatcher: WatcherRecord, tab: ExtensionBrowserTab, watcherId?: string): Promise<ActiveTabResult> => {
	if (tab.attached) {
		return { ok: true, tab, watcherId: tab.watcherId }
	}

	return attachTab(controlWatcher, tab, { watcherId })
}

const writeResolveFailure = (
	output: Output,
	options: ExtensionTabWatcherOptions,
	resolved: Exclude<Awaited<ReturnType<typeof resolveExtensionWatcher>>, { ok: true }>,
): void => {
	if (options.json) {
		output.writeJson({ ok: false, error: resolved.error, candidates: resolved.candidates?.map((watcher) => watcher.id) ?? [] })
	} else {
		output.writeWarn(resolved.error)
		for (const watcher of resolved.candidates ?? []) {
			output.writeWarn(formatWatcherLine(watcher))
		}
	}
	process.exitCode = resolved.exitCode
}

const writeTabFailure = (output: Output, _options: ExtensionTabWatcherOptions, result: TabActionFailure): void => {
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
