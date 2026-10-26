import { describeProtocolMismatch } from '@vforsh/argus-core'
import type { StatusResponse, WatcherRecord } from '@vforsh/argus-core'
import { loadActiveRegistry } from '../registry.js'
import { formatWatcherLine } from '../output/format.js'
import { createOutput } from '../output/io.js'
import { fetchWatcherJson, formatWatcherTransportError } from '../watchers/requestWatcher.js'
import { discoverChromeInstances, formatChromeInstanceLine } from './chrome.js'
import {
	detectHostVersionSkew,
	formatHostVersionSkew,
	formatHostVersionSkewMarker,
	NO_VERSION_WARNINGS_ENV,
	summarizeHostVersionSkews,
	type HostVersionSkew,
} from '../watchers/versionSkew.js'

/** Options for the list command. */
export type ListOptions = {
	json?: boolean
	byCwd?: string
	/** Suppress version-skew row markers and the summary line (also `ARGUS_NO_VERSION_WARNINGS=1`). */
	quiet?: boolean
}

type WatcherProbe = { watcher: WatcherRecord; status?: StatusResponse; warning?: string; skew?: HostVersionSkew }

/** Execute the list command. */
export const runList = async (options: ListOptions): Promise<void> => {
	const output = createOutput(options)

	const [probes, chromeInstances] = await Promise.all([listWatchers(options), discoverChromeInstances()])
	const skews = probes.flatMap((probe) => probe.skew ?? [])
	const quiet = options.quiet === true || isTruthyEnv(process.env[NO_VERSION_WARNINGS_ENV])

	if (options.json) {
		// Warnings ride in the document instead of stderr so `2>&1` captures stay parseable.
		const unreachableHint = describeAllUnreachable(probes)
		const warnings = [
			...probes.flatMap((probe) => probe.warning ?? []),
			...(unreachableHint ? [unreachableHint] : []),
			...(quiet ? [] : skews.map(formatHostVersionSkew)),
		]
		output.writeJson({
			watchers: probes.map((entry) => entry.status?.watcher ?? entry.watcher),
			chrome: chromeInstances,
			warnings,
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
	if (probes.length > 0) {
		for (const entry of probes) {
			const marker = entry.skew && !quiet ? ` [${formatHostVersionSkewMarker(entry.skew)}]` : ''
			output.writeHuman(`  ${formatWatcherLine(entry.watcher, entry.status ?? 'unreachable')}${marker}`)
		}
	} else {
		output.writeHuman('  (none)')
	}

	// Warnings follow the list so the list itself is the first thing read. Transport and protocol
	// failures stay one line per watcher; version skew is a row marker plus one summary line.
	const warnings = probes.flatMap((probe) => probe.warning ?? [])
	const unreachableHint = describeAllUnreachable(probes)
	if (unreachableHint) warnings.push(unreachableHint)
	const summary = quiet ? null : summarizeHostVersionSkews(skews)
	if (summary) warnings.push(summary)
	if (warnings.length > 0) {
		output.writeWarn('')
		for (const warning of warnings) output.writeWarn(warning)
	}
}

/**
 * Dead processes never reach this point (the registry read drops records whose pid is gone), so an
 * unreachable row is a live process that did not answer. When every watcher is like that, the
 * likely cause is this shell, not the watchers: agent sandboxes commonly block localhost sockets.
 */
const describeAllUnreachable = (probes: WatcherProbe[]): string | null => {
	if (probes.length < 2 || probes.some((probe) => probe.status)) return null
	return 'No watcher answered although their processes are alive. If this shell is sandboxed, allow localhost network access (or run outside the sandbox) and retry.'
}

const isTruthyEnv = (value: string | undefined): boolean => value != null && value !== '' && value !== '0' && value.toLowerCase() !== 'false'

const listWatchers = async (options: ListOptions): Promise<WatcherProbe[]> => {
	const registry = await loadActiveRegistry()

	let watchers = Object.values(registry.watchers)

	if (options.byCwd) {
		const substring = options.byCwd
		watchers = watchers.filter((watcher) => watcher.cwd && watcher.cwd.includes(substring))
	}

	if (watchers.length === 0) return []

	// Probed concurrently: these are independent 2s-timeout requests, so a registry with
	// five dead watchers used to make `argus list` take ten seconds. Results keep registry order.
	return Promise.all(
		watchers.map(async (watcher): Promise<WatcherProbe> => {
			try {
				const status = await fetchWatcherJson<StatusResponse>(watcher, { path: '/status', timeoutMs: 2_000 })
				const mismatch = describeProtocolMismatch(status.protocolVersion, status.watcherVersion)
				if (mismatch) {
					return { watcher, status, warning: `${watcher.id}: ${mismatch}` }
				}
				const skew = detectHostVersionSkew(watcher, status.watcherVersion)
				return skew ? { watcher, status, skew } : { watcher, status }
			} catch (error) {
				return { watcher, warning: formatWatcherTransportError(watcher, error) }
			}
		}),
	)
}
