import type { RegistryV1, WatcherRecord } from '@vforsh/argus-core'
import type { StatusResponse } from '@vforsh/argus-core'
import { fetchJson } from '../httpClient.js'
import { loadRegistry, pruneRegistry } from '../registry.js'

export type ResolveWatcherInput = {
	id?: string
}

export type ResolveWatcherResult =
	| { ok: true; watcher: WatcherRecord; registry: RegistryV1 }
	| { ok: false; error: string; exitCode: 1 | 2; candidates?: WatcherRecord[] }

export const resolveWatcher = async (input: ResolveWatcherInput): Promise<ResolveWatcherResult> => {
	let registry: RegistryV1
	try {
		registry = await pruneRegistry(await loadRegistry())
	} catch (error) {
		return { ok: false, error: `Failed to load registry: ${error instanceof Error ? error.message : error}`, exitCode: 1 }
	}

	const watchers = Object.values(registry.watchers)

	if (input.id) {
		const watcher = registry.watchers[input.id]
		if (!watcher) {
			return { ok: false, error: `Watcher not found: ${input.id}`, exitCode: 2, candidates: watchers }
		}
		return { ok: true, watcher, registry }
	}

	if (watchers.length === 0) {
		return { ok: false, error: 'Watcher id required.', exitCode: 2 }
	}

	const cwd = process.cwd()
	const cwdMatches = watchers.filter((watcher) => watcher.cwd === cwd)
	if (cwdMatches.length === 1) {
		return { ok: true, watcher: cwdMatches[0], registry }
	}
	if (cwdMatches.length > 1) {
		return { ok: false, error: 'Watcher id required.', exitCode: 2, candidates: cwdMatches }
	}

	const reachability = await Promise.all(
		watchers.map(async (watcher) => ({
			watcher,
			status: await checkWatcherStatus(watcher),
		})),
	)

	const reachable = reachability.filter((entry) => entry.status.ok)
	if (reachable.length === 1) {
		return { ok: true, watcher: reachable[0].watcher, registry }
	}

	return { ok: false, error: 'Watcher id required.', exitCode: 2, candidates: watchers }
}

const checkWatcherStatus = async (
	watcher: WatcherRecord,
): Promise<{ ok: true; status: StatusResponse } | { ok: false; error: string }> => {
	const url = `http://${watcher.host}:${watcher.port}/status`
	try {
		const status = await fetchJson<StatusResponse>(url, { timeoutMs: 1_500 })
		return { ok: true, status }
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) }
	}
}
