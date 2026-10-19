import type { WatcherRecord } from '@vforsh/argus-core'
import { WATCHER_VERSION } from '@vforsh/argus-watcher'
import packageJson from '../../package.json' with { type: 'json' }

/**
 * Detect watchers running a different watcher build than this CLI.
 *
 * Chrome keeps the native hosts it spawned until it respawns them (extension reload or browser
 * restart), so after an upgrade the CLI can talk to hosts from the previous install. The protocol
 * version only catches breaking changes; this compares the package versions themselves.
 *
 * The CLI (`@vforsh/argus`) and the watcher (`@vforsh/argus-watcher`) are versioned separately, so
 * the expected version is the watcher build this CLI bundles, not `argus --version`. Messages name
 * both so the two numbers never read as a contradiction.
 */
export type HostVersionSkew = {
	watcherId: string
	hostVersion: string
	expectedVersion: string
	/** Whether the watcher is an extension native host (respawned by Chrome) or a CLI-started process. */
	source: 'extension' | 'cli'
	/** What to do about it. */
	action: string
}

/** Env var that silences version-skew warnings in `argus list` for scripts. */
export const NO_VERSION_WARNINGS_ENV = 'ARGUS_NO_VERSION_WARNINGS'

const EXTENSION_ACTION = 'Reload the extension at chrome://extensions or restart the browser to respawn native hosts.'
const CLI_ACTION = 'Restart the watcher to pick up the installed version.'

/** `argus <cli> bundles watcher <watcher>`: the one place both version numbers are spelled out. */
export const describeBundledWatcher = (): string => `argus ${packageJson.version} bundles watcher ${WATCHER_VERSION}`

/** @returns The skew, or `null` when versions match or the host didn't report one. */
export const detectHostVersionSkew = (watcher: WatcherRecord, hostVersion: string | null | undefined): HostVersionSkew | null => {
	if (!hostVersion || hostVersion === WATCHER_VERSION) {
		return null
	}
	const source = watcher.source === 'extension' ? 'extension' : 'cli'
	return {
		watcherId: watcher.id,
		hostVersion,
		expectedVersion: WATCHER_VERSION,
		source,
		action: source === 'extension' ? EXTENSION_ACTION : CLI_ACTION,
	}
}

/** One-line human description of a skew, including the next action. */
export const formatHostVersionSkew = (skew: HostVersionSkew): string =>
	`${skew.watcherId} runs watcher ${skew.hostVersion}, but ${describeBundledWatcher()}. ${skew.action}`

/** Short per-row marker for list output, e.g. `outdated: watcher 0.5.16`. */
export const formatHostVersionSkewMarker = (skew: HostVersionSkew): string =>
	`${compareVersions(skew.hostVersion, skew.expectedVersion) < 0 ? 'outdated' : 'version mismatch'}: watcher ${skew.hostVersion}`

/**
 * Collapse every skew into one line, e.g.
 * `4 watchers run other watcher builds (0.5.16–0.5.18; argus 0.5.26 bundles watcher 0.5.19): restart CLI watchers or reload the extension. Details: argus ext doctor. …`.
 */
export const summarizeHostVersionSkews = (skews: readonly HostVersionSkew[]): string | null => {
	if (skews.length === 0) {
		return null
	}
	const versions = [...new Set(skews.map((skew) => skew.hostVersion))].sort(compareVersions)
	const range = versions.length === 1 ? versions[0] : `${versions[0]}–${versions[versions.length - 1]}`
	const subject = skews.length === 1 ? `1 watcher runs another watcher build` : `${skews.length} watchers run other watcher builds`
	const hasExtension = skews.some((skew) => skew.source === 'extension')
	const hasCli = skews.some((skew) => skew.source === 'cli')
	const action = [hasCli ? 'restart CLI watchers' : null, hasExtension ? 'reload the extension' : null].filter(Boolean).join(' or ')
	const details = hasExtension ? ' Details: argus ext doctor.' : ''
	return `${subject} (${range}; ${describeBundledWatcher()}): ${action}.${details} Silence: --quiet or ${NO_VERSION_WARNINGS_ENV}=1`
}

/** Numeric dotted-version compare; non-numeric parts sort as 0. Good enough for ordering a warning range. */
const compareVersions = (left: string, right: string): number => {
	const a = left.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0)
	const b = right.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0)
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const diff = (a[i] ?? 0) - (b[i] ?? 0)
		if (diff !== 0) return diff
	}
	return 0
}
