import type { ApiResult, ExtensionBrowserTab, ExtensionTabMuteResponse, WatcherRecord } from '@vforsh/argus-core'
import { formatError } from '../../cli/parse.js'
import { createOutput, type Output } from '../../output/io.js'
import { fetchWatcherJson } from '../../watchers/requestWatcher.js'
import { emitFailure, emitResolveFailure } from './failures.js'
import { resolveExtensionWatcher } from './resolveExtensionWatcher.js'
import {
	fetchExtensionTabs,
	formatExtensionTabLine,
	hasTabSelector,
	parseTabSelector,
	resolveTab,
	type ExtensionTabSelectorOptions,
} from './tabSelection.js'

export type ExtensionMuteOptions = ExtensionTabSelectorOptions & {
	json?: boolean
}

/** Set a browser tab's persistent mute state through the extension-control bridge. */
export const runExtensionMute = async (id: string | undefined, options: ExtensionMuteOptions, muted: boolean): Promise<void> => {
	const output = createOutput(options)
	if (id && hasTabSelector(options)) {
		emitFailure(output, { error: 'Use either watcher id or --tab/--url/--title, not both.', exitCode: 2 })
		return
	}

	const control = await resolveExtensionWatcher({})
	if (!control.ok) {
		emitResolveFailure(output, control)
		return
	}

	const tab = id ? await resolveTabByWatcherId(control.watcher, id, output) : await resolveTabBySelector(control.watcher, options, output)
	if (!tab) {
		return
	}

	let response: ApiResult<ExtensionTabMuteResponse>
	try {
		response = await fetchWatcherJson<ApiResult<ExtensionTabMuteResponse>>(control.watcher, {
			path: '/tabs/mute',
			method: 'POST',
			body: { tabId: tab.tabId, muted },
			timeoutMs: 5_000,
			returnErrorResponse: true,
		})
	} catch (error) {
		emitFailure(output, { error: `${control.watcher.id}: failed to ${muted ? 'mute' : 'unmute'} tab (${formatError(error)})` })
		return
	}

	if (!response.ok) {
		emitFailure(output, { error: response })
		return
	}

	if (options.json) {
		output.writeJson({ ok: true, muted: response.muted, tab: response.tab, viaWatcherId: control.watcher.id })
		return
	}

	output.writeHuman(`${response.muted ? 'muted' : 'unmuted'} tab ${response.tab.tabId}`)
	output.writeHuman(`  ${formatExtensionTabLine(response.tab)}`)
}

const resolveTabByWatcherId = async (control: WatcherRecord, id: string, output: Output): Promise<ExtensionBrowserTab | null> => {
	const tabs = await fetchExtensionTabs(control, { kind: 'query' })
	if (!tabs.ok) {
		emitFailure(output, { error: tabs.error })
		return null
	}

	const matches = tabs.tabs.filter((tab) => tab.watcherId === id)
	if (matches.length === 1) {
		return matches[0]
	}

	emitFailure(output, {
		error:
			matches.length === 0 ? `No extension tab is attached as ${id}.` : `Multiple extension tabs are attached as ${id}. Use --tab to pick one.`,
		exitCode: 2,
		details: { matches },
		hints: matches.map((tab) => `  ${formatExtensionTabLine(tab)}`),
	})
	return null
}

const resolveTabBySelector = async (control: WatcherRecord, options: ExtensionMuteOptions, output: Output): Promise<ExtensionBrowserTab | null> => {
	const selector = parseTabSelector(options, 'Specify a watcher id, --tab <tabId>, --url <substring>, or --title <substring>.')
	if (!selector.ok) {
		emitFailure(output, { error: selector.reason, exitCode: selector.exitCode })
		return null
	}

	const tabs = await fetchExtensionTabs(control, selector.selector)
	if (!tabs.ok) {
		emitFailure(output, { error: tabs.error })
		return null
	}

	const resolved = resolveTab(tabs.tabs, selector.selector)
	if (resolved.ok) {
		return resolved.tab
	}

	emitFailure(output, {
		error: resolved.reason,
		exitCode: resolved.exitCode,
		details: { matches: resolved.matches ?? [] },
		hints: (resolved.matches ?? []).map((tab) => `  ${formatExtensionTabLine(tab)}`),
	})
	return null
}
