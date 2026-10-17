import { emitFailure, emitResolveFailure } from './failures.js'
import type { ErrorResponse, ExtensionBrowserTab, ExtensionTabActionResponse, ApiResult } from '@vforsh/argus-core'
import { createOutput } from '../../output/io.js'
import { fetchWatcherJson } from '../../watchers/requestWatcher.js'
import { resolveExtensionWatcher, resolveExtensionWatcherForTab } from './resolveExtensionWatcher.js'
import { runExtensionShow } from './show.js'
import { waitForTabWatcher } from './tabAttach.js'
import { resolveTabByWatcherId } from './mute.js'
import {
	fetchExtensionTabs,
	formatExtensionTabLine,
	hasTabSelector,
	parseTabSelector,
	resolveTab,
	type SelectorResult,
	type TabResolutionResult,
} from './tabSelection.js'
import { formatError } from '../../cli/parse.js'

export type ExtensionAttachOptions = ExtensionTabActionOptions & { show?: boolean }
export type ExtensionDetachOptions = ExtensionTabActionOptions

type ExtensionTabActionOptions = {
	id?: string
	/** Browser label or instance id; alternative to `id`. */
	browser?: string
	tab?: string | number
	url?: string
	title?: string
	as?: string
	wait?: boolean
	json?: boolean
}

type ExtensionTabAction = 'attach' | 'detach'

export const runExtensionAttach = async (options: ExtensionAttachOptions): Promise<void> => {
	if (options.show) {
		await runExtensionShow(undefined, options, {
			missingSelectorReason: 'Specify --tab <tabId>, --url <substring>, or --title <substring>.',
		})
		return
	}

	await runExtensionTabAction('attach', options)
}

/** Detach a tab picked by its tab watcher id (`watcherId`) or by --tab/--url/--title. */
export const runExtensionDetach = async (watcherId: string | undefined, options: ExtensionDetachOptions): Promise<void> => {
	await runExtensionTabAction('detach', options, watcherId)
}

const runExtensionTabAction = async (action: ExtensionTabAction, options: ExtensionTabActionOptions, watcherId?: string): Promise<void> => {
	const output = createOutput(options)
	if (watcherId && hasTabSelector(options)) {
		emitFailure(output, { error: 'Use either watcher id or --tab/--url/--title, not both.', exitCode: 2 })
		return
	}

	const resolved = await resolveExtensionWatcherForTab(options, watcherId)
	if (!resolved.ok) {
		writeResolveFailure(output, options, resolved)
		return
	}

	const tab = watcherId ? await resolveTabByWatcherId(resolved.watcher, watcherId, output) : await resolveSelectedTab(resolved.watcher, options, output)
	if (!tab) {
		return
	}

	let response: ApiResult<ExtensionTabActionResponse>
	try {
		response = await fetchWatcherJson<ApiResult<ExtensionTabActionResponse>>(resolved.watcher, {
			path: action === 'attach' ? '/attach' : '/detach',
			method: 'POST',
			body: { tabId: tab.tabId, watcherId: action === 'attach' ? options.as : undefined },
			timeoutMs: action === 'attach' ? 18_000 : 5_000,
			returnErrorResponse: true,
		})
	} catch (error) {
		const message = formatError(error)
		writeCommandError(output, options, `${resolved.watcher.id}: failed to ${action} tab (${message})`, message)
		return
	}

	if (!response.ok) {
		writeCommandError(output, options, `Error: ${response.error.message}`, response)
		return
	}

	if (action === 'attach' && options.wait !== false) {
		const watcher = await waitForTabWatcher(
			resolved.watcher,
			{ kind: 'tab', tabId: response.tab.tabId },
			{ ...response.tab, attached: true },
			response.watcherId ?? options.as,
		)
		if (!watcher.ok) {
			writeCommandError(output, options, watcher.reason, {
				ok: false,
				error: watcher.reason,
				tab: response.tab,
				watcherId: response.watcherId ?? options.as,
			})
			return
		}

		if (options.json) {
			output.writeJson({
				ok: true,
				tab: watcher.tab,
				watcherId: watcher.watcher.id,
				status: watcher.status,
			})
			return
		}

		output.writeHuman(`attached ${watcher.watcher.id}`)
		output.writeHuman(`  ${formatExtensionTabLine(watcher.tab)}`)
		return
	}

	// The extension's detach reply carries no watcher id, but the tab listing knew who owned it.
	const resultWatcherId = response.watcherId ?? (action === 'detach' ? tab.watcherId : undefined)
	if (options.json) {
		output.writeJson({
			ok: true,
			tab: response.tab,
			watcherId: resultWatcherId,
		})
		return
	}

	const verb = action === 'attach' ? 'attached' : 'detached'
	output.writeHuman(`${verb}${resultWatcherId ? ` ${resultWatcherId}` : ''}`)
	output.writeHuman(`  ${formatExtensionTabLine(response.tab)}`)
}

type TabActionFailure = Exclude<TabResolutionResult, { ok: true }> | Exclude<SelectorResult, { ok: true }>

const resolveSelectedTab = async (
	control: Parameters<typeof fetchExtensionTabs>[0],
	options: ExtensionTabActionOptions,
	output: ReturnType<typeof createOutput>,
): Promise<ExtensionBrowserTab | null> => {
	const selector = parseTabSelector(options, 'Specify --tab <tabId>, --url <substring>, or --title <substring>.')
	if (!selector.ok) {
		writeTabResolutionFailure(output, options, selector)
		return null
	}

	const tabs = await fetchExtensionTabs(control, selector.selector)
	if (!tabs.ok) {
		writeCommandError(output, options, tabs.error, tabs.error)
		return null
	}

	const tab = resolveTab(tabs.tabs, selector.selector)
	if (!tab.ok) {
		writeTabResolutionFailure(output, options, tab)
		return null
	}
	return tab.tab
}

const writeTabResolutionFailure = (output: ReturnType<typeof createOutput>, _options: ExtensionTabActionOptions, result: TabActionFailure): void => {
	const matches = 'matches' in result ? (result.matches ?? []) : []
	emitFailure(output, {
		error: result.reason,
		exitCode: result.exitCode,
		hints: matches.map((tab) => `  ${formatExtensionTabLine(tab)}`),
		details: { matches },
	})
}

const writeResolveFailure = (
	output: ReturnType<typeof createOutput>,
	options: ExtensionTabActionOptions,
	resolved: Exclude<Awaited<ReturnType<typeof resolveExtensionWatcher>>, { ok: true }>,
): void => {
	emitResolveFailure(output, resolved)
}

const writeCommandError = (
	output: ReturnType<typeof createOutput>,
	options: ExtensionTabActionOptions,
	humanMessage: string,
	jsonPayload: string | Record<string, unknown> | ErrorResponse,
): void => {
	if (options.json) {
		output.writeJson(typeof jsonPayload === 'string' ? { ok: false, error: jsonPayload } : jsonPayload)
	} else {
		output.writeWarn(humanMessage)
	}
	process.exitCode = 1
}
