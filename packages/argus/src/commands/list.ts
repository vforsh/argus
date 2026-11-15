import { describeProtocolMismatch } from '@vforsh/argus-core'
import type { StatusResponse, WatcherRecord } from '@vforsh/argus-core'
import { loadActiveRegistry } from '../registry.js'
import { formatCompactWatcherLine, formatWatcherLine } from '../output/format.js'
import { createOutput, type Output } from '../output/io.js'
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
	/** The full table: host:port, match rules, cwd, target URLs, Chrome instances, version skew. */
	verbose?: boolean
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

	if (!options.verbose) {
		writeCompactList(probes, chromeInstances.length, output)
		return
	}

	// Section headers are not payload: stderr, so stdout stays the rows (`argus list | wc -l` counts watchers).
	output.writeWarn('Browsers')
	if (chromeInstances.length > 0) {
		for (const r of chromeInstances) {
			output.writeHuman(`  ${formatChromeInstanceLine(r)}`)
		}
	} else {
		output.writeHuman('  (none)')
	}

	output.writeWarn('')
	output.writeWarn('Watchers')
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
 * Default `list`: one `id · state · title · age` row per answering watcher on stdout.
 *
 * The full table averaged ~250 chars per watcher (cwd, host:port, match rules, full target URLs,
 * a version-skew marker on every row); agents called `list` 96 times in a week to pick an id.
 * Unreachable watchers and the Chrome count become one stderr line each, pointing at the fix.
 */
const writeCompactList = (probes: WatcherProbe[], chromeCount: number, output: Output): void => {
	const reachable = probes.filter((probe) => probe.status)
	const unreachable = probes.filter((probe) => !probe.status)
	const now = Date.now()
	for (const probe of reachable) output.writeHuman(formatCompactWatcherLine(probe.watcher, probe.status!, now))

	if (probes.length === 0) {
		output.writeWarn('No watchers. Start one: argus start --id app --url <url>, or argus ext use --url <substr> --as app')
	}
	if (unreachable.length > 0) {
		const hint = describeAllUnreachable(probes) ?? 'argus watcher prune removes them'
		output.writeWarn(`${unreachable.length} not answering: ${unreachable.map((probe) => probe.watcher.id).join(', ')} (${hint})`)
	}
	const mismatches = probes.flatMap((probe) => (probe.status && probe.warning ? [probe.warning] : []))
	for (const warning of mismatches) output.writeWarn(warning)
	if (chromeCount > 0 || probes.some((probe) => probe.skew)) output.writeWarn('more: argus list --verbose (Chrome instances, cwd, URLs, version skew)')
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
	// Lock-free on purpose: dead processes and expired records are already dropped from this read, and
	// physically pruning (`pruneRegistry`) would make `list` wait on — and fail with — a stale registry lock
	// or a read-only registry dir. Unreachable-but-alive watchers collapse into one stderr line instead.
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
