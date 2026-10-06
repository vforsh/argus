import { emitFailure, emitResolveFailure } from './failures.js'
import { formatError } from '../../cli/parse.js'
import type { ExtensionBrowserTab, VisibilityResponse, WatcherRecord, ApiResult } from '@vforsh/argus-core'
import { createOutput } from '../../output/io.js'
import { fetchWatcherJson } from '../../watchers/requestWatcher.js'
import { resolveWatcher } from '../../watchers/resolveWatcher.js'
import { resolveExtensionWatcher } from './resolveExtensionWatcher.js'
import { attachResolvedExtensionTabWatcher } from './tabWatcher.js'
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
	id?: string
	/** Browser label or instance id; alternative to `id`. */
	browser?: string
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

	const control = await resolveExtensionWatcher(options)
	if (!control.ok) {
		emitResolveFailure(output, control)
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

	const bound = await attachResolvedExtensionTabWatcher(control.watcher, tabResult.tab, options, output)
	if (!bound) return
	await showWatcher(bound.watcher, bound.tab, output, options)
}

export const showWatcher = async (
	watcher: WatcherRecord,
	tab: ExtensionBrowserTab | null,
	output: ReturnType<typeof createOutput>,
	options: ExtensionShowOptions,
): Promise<void> => {
	let response: ApiResult<VisibilityResponse>
	try {
		response = await fetchWatcherJson<ApiResult<VisibilityResponse>>(watcher, {
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

const writeFailure = (
	output: ReturnType<typeof createOutput>,
	_options: ExtensionShowOptions,
	error: string,
	exitCode: 1 | 2,
	extra: Record<string, unknown> = {},
): void => {
	const matches = Array.isArray(extra.matches) ? extra.matches : []
	emitFailure(output, {
		error,
		exitCode,
		hints: matches.filter(isExtensionTab).map((tab) => `  ${formatExtensionTabLine(tab)}`),
		details: extra,
	})
}
