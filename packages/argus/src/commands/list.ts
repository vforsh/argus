import { describeProtocolMismatch } from '@vforsh/argus-core'
import type { StatusResponse, WatcherRecord } from '@vforsh/argus-core'
import { pruneRegistry } from '../registry.js'
import { formatWatcherLine } from '../output/format.js'
import { createOutput } from '../output/io.js'
import { fetchWatcherJson, formatWatcherTransportError } from '../watchers/requestWatcher.js'
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

	// Probed concurrently: these are independent 2s-timeout requests, so a registry with
	// five dead watchers used to make `argus list` take ten seconds. Warnings are written
	// after the fact so their order still follows the registry, not completion order.
	const probes = await Promise.all(
		watchers.map(async (watcher): Promise<{ watcher: WatcherRecord; status?: StatusResponse; warning?: string }> => {
			try {
				const status = await fetchWatcherJson<StatusResponse>(watcher, { path: '/status', timeoutMs: 2_000 })
				const mismatch = describeProtocolMismatch(status.protocolVersion, status.watcherVersion)
				return mismatch ? { watcher, status, warning: `${watcher.id}: ${mismatch}` } : { watcher, status }
			} catch (error) {
				return { watcher, warning: formatWatcherTransportError(watcher, error) }
			}
		}),
	)

	for (const probe of probes) {
		if (probe.warning) {
			output.writeWarn(probe.warning)
		}
	}

	return probes.map(({ watcher, status }) => (status ? { watcher, status } : { watcher }))
}
