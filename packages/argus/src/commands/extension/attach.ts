import type { ErrorResponse } from '@vforsh/argus-core'
import { createOutput } from '../../output/io.js'
import { formatWatcherLine } from '../../output/format.js'
import { fetchWatcherJson } from '../../watchers/requestWatcher.js'
import { resolveExtensionWatcher } from './resolveExtensionWatcher.js'
import { runExtensionShow } from './show.js'
import {
	fetchExtensionTabs,
	formatExtensionTabLine,
	parseTabSelector,
	resolveTab,
	type SelectorResult,
	type TabResolutionResult,
} from './tabSelection.js'

export type ExtensionAttachOptions = ExtensionTabActionOptions & { show?: boolean }
export type ExtensionDetachOptions = ExtensionTabActionOptions

type ExtensionTabActionOptions = {
	tab?: string | number
	url?: string
	title?: string
	json?: boolean
}

type ExtensionTabAction = 'attach' | 'detach'

type ActionResponse = {
	ok: true
	message?: string
}

export const runExtensionAttach = async (options: ExtensionAttachOptions): Promise<void> => {
	if (options.show) {
		await runExtensionShow(undefined, options, {
			missingSelectorReason: 'Specify --tab <tabId>, --url <substring>, or --title <substring>.',
		})
		return
	}

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

	const selector = parseTabSelector(options, 'Specify --tab <tabId>, --url <substring>, or --title <substring>.')
	if (!selector.ok) {
		writeTabResolutionFailure(output, options, selector)
		return
	}

	const tabs = await fetchExtensionTabs(resolved.watcher, selector.selector)
	if (!tabs.ok) {
		writeCommandError(output, options, tabs.error, tabs.error)
		return
	}

	const tab = resolveTab(tabs.tabs, selector.selector)
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

type TabActionFailure = Exclude<TabResolutionResult, { ok: true }> | Exclude<SelectorResult, { ok: true }>

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
