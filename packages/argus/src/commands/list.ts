import type { StatusResponse, WatcherRecord } from '@vforsh/argus-core'
import { pruneRegistry } from '../registry.js'
import { fetchJson } from '../httpClient.js'
import { formatError } from '../cli/parse.js'
import { formatWatcherLine } from '../output/format.js'
import { createOutput } from '../output/io.js'
import { discoverChromeInstances, formatChromeInstanceLine } from './chrome.js'

/** Options for the list command. */
export type ListOptions = {
	json?: boolean
	byCwd?: string
}

/** Execute the list command. */
export const runList = async (options: ListOptions): Promise<void> => {
	const output = createOutput(options)

	const [watcherResults, chromeInstances] = await Promise.all([listWatchers(options, output), discoverChromeInstances()])

	if (options.json) {
		output.writeJson({
			watchers: watcherResults.map((entry) => entry.status?.watcher ?? entry.watcher),
			chrome: chromeInstances,
		})
		return
	}

	output.writeHuman('Browsers')
	if (chromeInstances.length > 0) {
		for (const r of chromeInstances) {
			output.writeHuman(`  ${formatChromeInstanceLine(r)}`)
		}
	} else {
		output.writeHuman('  (none)')
	}

	output.writeHuman('')
	output.writeHuman('Watchers')
	if (watcherResults.length > 0) {
		for (const entry of watcherResults) {
			output.writeHuman(`  ${formatWatcherLine(entry.watcher, entry.status)}`)
		}
	} else {
		output.writeHuman('  (none)')
	}
}

const listWatchers = async (
	options: ListOptions,
	output: ReturnType<typeof createOutput>,
): Promise<Array<{ watcher: WatcherRecord; status?: StatusResponse }>> => {
	const registry = await pruneRegistry()

	let watchers = Object.values(registry.watchers)

	if (options.byCwd) {
		const substring = options.byCwd
		watchers = watchers.filter((watcher) => watcher.cwd && watcher.cwd.includes(substring))
	}

	if (watchers.length === 0) return []

	const results: Array<{ watcher: WatcherRecord; status?: StatusResponse }> = []

	for (const watcher of watchers) {
		const url = `http://${watcher.host}:${watcher.port}/status`
		try {
			const status = await fetchJson<StatusResponse>(url, { timeoutMs: 2_000 })
			results.push({ watcher, status })
		} catch (error) {
			output.writeWarn(`${watcher.id}: failed to reach watcher (${formatError(error)})`)
			results.push({ watcher })
		}
	}

	return results
}
