import type { ErrorResponse, ExtensionBrowserTab, ExtensionTabsResponse } from '@vforsh/argus-core'
import { createOutput } from '../../output/io.js'
import { formatWatcherLine } from '../../output/format.js'
import { fetchWatcherJson } from '../../watchers/requestWatcher.js'
import { resolveExtensionWatcher } from './resolveExtensionWatcher.js'

export type ExtensionTabsOptions = {
	id?: string
	url?: string
	title?: string
	json?: boolean
}

export const runExtensionTabs = async (options: ExtensionTabsOptions): Promise<void> => {
	const output = createOutput(options)
	const resolved = await resolveExtensionWatcher({ id: options.id })
	if (!resolved.ok) {
		writeResolveFailure(output, options, resolved)
		return
	}

	const query = buildTabsQuery(options)

	let response: ExtensionTabsResponse | ErrorResponse
	try {
		response = await fetchWatcherJson<ExtensionTabsResponse | ErrorResponse>(resolved.watcher, {
			path: '/tabs',
			query,
			timeoutMs: 5_000,
			returnErrorResponse: true,
		})
	} catch (error) {
		writeCommandError(output, options, `${resolved.watcher.id}: failed to list extension tabs (${formatError(error)})`, formatError(error))
		process.exitCode = 1
		return
	}

	if (!response.ok) {
		writeCommandError(output, options, `Error: ${response.error.message}`, response)
		process.exitCode = 1
		return
	}

	if (options.json) {
		output.writeJson({
			viaWatcherId: resolved.watcher.id,
			tabs: response.tabs,
		})
		return
	}

	output.writeHuman(`Extension tabs via ${resolved.watcher.id}`)
	if (response.tabs.length === 0) {
		output.writeHuman('  (none)')
		return
	}

	for (const tab of response.tabs) {
		output.writeHuman(`  ${formatExtensionTabLine(tab)}`)
	}
}

const formatExtensionTabLine = (tab: ExtensionBrowserTab): string => {
	const state = tab.attached ? 'attached' : 'available'
	const label = tab.title || '(untitled)'
	return `${tab.tabId} [${state}] ${label} - ${tab.url}`
}

const buildTabsQuery = (options: ExtensionTabsOptions): URLSearchParams => {
	const query = new URLSearchParams()
	const url = options.url?.trim()
	const title = options.title?.trim()

	if (url) {
		query.set('url', url)
	}
	if (title) {
		query.set('title', title)
	}

	return query
}

const writeResolveFailure = (
	output: ReturnType<typeof createOutput>,
	options: ExtensionTabsOptions,
	resolved: Exclude<Awaited<ReturnType<typeof resolveExtensionWatcher>>, { ok: true }>,
): void => {
	if (options.json) {
		output.writeJson({ ok: false, error: resolved.error, candidates: resolved.candidates?.map((watcher) => watcher.id) ?? [] })
	}

	output.writeWarn(resolved.error)
	if (resolved.candidates && resolved.candidates.length > 0) {
		for (const watcher of resolved.candidates) {
			output.writeWarn(formatWatcherLine(watcher))
		}
		output.writeWarn('Hint: pass --id <watcherId> to pick one extension watcher.')
	}

	process.exitCode = resolved.exitCode
}

const writeCommandError = (
	output: ReturnType<typeof createOutput>,
	options: ExtensionTabsOptions,
	humanMessage: string,
	jsonPayload: string | ErrorResponse,
): void => {
	if (options.json) {
		output.writeJson(typeof jsonPayload === 'string' ? { ok: false, error: jsonPayload } : jsonPayload)
	}
	output.writeWarn(humanMessage)
}

const formatError = (error: unknown): string => (error instanceof Error ? error.message : String(error))
