import type { StatusResponse, RegistryV1, WatcherRecord } from '@vforsh/argus-core'
import { pruneRegistry } from '../../registry.js'
import { fetchWatcherJson } from '../../watchers/requestWatcher.js'

export type ResolveExtensionWatcherInput = {
	id?: string
}

export type ResolveExtensionWatcherResult =
	| { ok: true; watcher: WatcherRecord; registry: RegistryV1 }
	| { ok: false; error: string; exitCode: 1 | 2; candidates?: WatcherRecord[] }

/**
 * Resolve a watcher that is known to be backed by the Chrome extension transport.
 * When id is omitted, mirror the generic watcher heuristics but only across extension watchers.
 */
export const resolveExtensionWatcher = async (input: ResolveExtensionWatcherInput): Promise<ResolveExtensionWatcherResult> => {
	let registry: RegistryV1
	try {
		registry = await pruneRegistry()
	} catch (error) {
		return { ok: false, error: `Failed to load registry: ${error instanceof Error ? error.message : error}`, exitCode: 1 }
	}

	const allWatchers = Object.values(registry.watchers)

	if (input.id) {
		const watcher = registry.watchers[input.id]
		if (!watcher) {
			return { ok: false, error: `Watcher not found: ${input.id}`, exitCode: 2, candidates: allWatchers }
		}
		if (watcher.source !== 'extension') {
			return { ok: false, error: `Watcher ${watcher.id} is not extension-backed.`, exitCode: 2, candidates: getExtensionWatchers(allWatchers) }
		}
		return { ok: true, watcher, registry }
	}

	const extensionWatchers = getExtensionWatchers(allWatchers)
	if (extensionWatchers.length === 0) {
		return {
			ok: false,
			error: 'No extension-backed watchers found. Attach a tab in the extension popup first.',
			exitCode: 2,
		}
	}

	const reachability = await Promise.all(
		extensionWatchers.map(async (watcher) => ({
			watcher,
			status: await checkWatcherStatus(watcher),
		})),
	)

	const attached = reachability.filter((entry) => entry.status.ok && entry.status.status.attached)
	if (attached.length === 1) {
		return { ok: true, watcher: attached[0].watcher, registry }
	}

	const cwd = process.cwd()
	const cwdMatches = extensionWatchers.filter((watcher) => watcher.cwd === cwd)
	const attachedCwdMatches = attached.filter((entry) => entry.watcher.cwd === cwd)
	if (attachedCwdMatches.length === 1) {
		return { ok: true, watcher: attachedCwdMatches[0].watcher, registry }
	}
	if (attached.length > 1) {
		return { ok: false, error: 'Watcher id required.', exitCode: 2, candidates: attached.map((entry) => entry.watcher) }
	}

	if (cwdMatches.length === 1) {
		return { ok: true, watcher: cwdMatches[0], registry }
	}
	if (cwdMatches.length > 1) {
		return { ok: false, error: 'Watcher id required.', exitCode: 2, candidates: cwdMatches }
	}

	const reachable = reachability.filter((entry) => entry.status.ok)
	if (reachable.length === 1) {
		return { ok: true, watcher: reachable[0].watcher, registry }
	}

	return { ok: false, error: 'Watcher id required.', exitCode: 2, candidates: extensionWatchers }
}

const getExtensionWatchers = (watchers: WatcherRecord[]): WatcherRecord[] => watchers.filter((watcher) => watcher.source === 'extension')

const checkWatcherStatus = async (watcher: WatcherRecord): Promise<{ ok: true; status: StatusResponse } | { ok: false; error: string }> => {
	try {
		const status = await fetchWatcherJson<StatusResponse>(watcher, { path: '/status', timeoutMs: 1_500 })
		return { ok: true, status }
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) }
	}
}
