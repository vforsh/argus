import type { WatcherRecord } from '@vforsh/argus-core'
import { WATCHER_VERSION } from '@vforsh/argus-watcher'

/**
 * Detect watchers running a different watcher build than this CLI.
 *
 * Chrome keeps the native hosts it spawned until it respawns them (extension reload or browser
 * restart), so after an upgrade the CLI can talk to hosts from the previous install. The protocol
 * version only catches breaking changes; this compares the package versions themselves.
 */
export type HostVersionSkew = {
	watcherId: string
	hostVersion: string
	expectedVersion: string
	/** What to do about it. */
	action: string
}

/** @returns The skew, or `null` when versions match or the host didn't report one. */
export const detectHostVersionSkew = (watcher: WatcherRecord, hostVersion: string | null | undefined): HostVersionSkew | null => {
	if (!hostVersion || hostVersion === WATCHER_VERSION) {
		return null
	}
	return {
		watcherId: watcher.id,
		hostVersion,
		expectedVersion: WATCHER_VERSION,
		action:
			watcher.source === 'extension'
				? 'Reload the extension at chrome://extensions or restart the browser to respawn native hosts.'
				: 'Restart the watcher to pick up the installed version.',
	}
}

/** One-line human description of a skew, including the next action. */
export const formatHostVersionSkew = (skew: HostVersionSkew): string =>
	`${skew.watcherId} runs watcher ${skew.hostVersion}, but this CLI ships ${skew.expectedVersion}. ${skew.action}`
