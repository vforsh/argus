import type { ErrorResponse, ExtensionBrowserTab, VisibilityResponse, WatcherRecord } from '@vforsh/argus-core'
import { createOutput } from '../../output/io.js'
import { fetchWatcherJson } from '../../watchers/requestWatcher.js'
import { resolveWatcher } from '../../watchers/resolveWatcher.js'
import { resolveExtensionWatcher } from './resolveExtensionWatcher.js'
import { attachTab, waitForTabWatcher, type WatcherResolutionResult } from './tabAttach.js'
import {
	fetchExtensionTabs,
	formatExtensionTabLine,
	hasTabSelector,
	isExtensionTab,
	parseTabSelector,
	resolveTab,
	type TabResolutionResult,
} from './tabSelection.js'

export type ExtensionShowOptions = {
	tab?: string | number
	url?: string
	title?: string
	as?: string
	json?: boolean
}

type ExtensionShowConfig = {
	missingSelectorReason?: string
}

type TabResolutionFailure = Exclude<TabResolutionResult, { ok: true }>
type WatcherResolutionFailure = Exclude<WatcherResolutionResult, { ok: true }>

export const runExtensionShow = async (id: string | undefined, options: ExtensionShowOptions, config: ExtensionShowConfig = {}): Promise<void> => {
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

	const selector = parseTabSelector(
		options,
		config.missingSelectorReason ?? 'Specify a watcher id, --tab <tabId>, --url <substring>, or --title <substring>.',
	)
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
	if (options.as && tab.attached && tab.watcherId && tab.watcherId !== options.as) {
		writeFailure(output, options, `Tab ${tab.tabId} is already attached as ${tab.watcherId}. Detach it before re-attaching as ${options.as}.`, 2)
		return
	}

	let attachedTab = tab
	let attachedWatcherId = tab.watcherId
	if (!tab.attached) {
		const attached = await attachTab(control.watcher, tab, { watcherId: options.as })
		if (!attached.ok) {
			writeFailure(output, options, attached.error, 1)
			return
		}
		attachedTab = attached.tab
		attachedWatcherId = attached.watcherId
	}

	const watcherResult = await waitForTabWatcher(
		control.watcher,
		selector.selector,
		{ ...attachedTab, attached: true },
		attachedWatcherId ?? options.as,
	)
	if (!watcherResult.ok) {
		writeWatcherFailure(output, options, watcherResult)
		return
	}

	await showWatcher(watcherResult.watcher, watcherResult.tab, output, options)
}

export const showWatcher = async (
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

const formatError = (error: unknown): string => (error instanceof Error ? error.message : String(error))
