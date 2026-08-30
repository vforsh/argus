import { formatExtensionTabLine } from './tabSelection.js'
import { emitFailure, emitResolveFailure } from './failures.js'
import { formatError } from '../../cli/parse.js'
import type { ErrorResponse, ExtensionTabsResponse } from '@vforsh/argus-core'
import { createOutput } from '../../output/io.js'
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
		emitResolveFailure(output, resolved)
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
		emitFailure(output, { error: `${resolved.watcher.id}: failed to list extension tabs (${formatError(error)})` })
		return
	}

	if (!response.ok) {
		emitFailure(output, { error: response })
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
