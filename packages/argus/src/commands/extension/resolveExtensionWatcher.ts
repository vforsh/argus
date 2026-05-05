import type { StatusResponse, RegistryV1, WatcherRecord } from '@vforsh/argus-core'
import { pruneRegistry } from '../../registry.js'
import { fetchWatcherJson } from '../../watchers/requestWatcher.js'
import { CONTROL_WATCHER_ID } from './nativeHost.js'

export type ResolveExtensionWatcherInput = {
	id?: string
}

export type ResolveExtensionWatcherResult =
	| { ok: true; watcher: WatcherRecord; registry: RegistryV1 }
	| { ok: false; error: string; exitCode: 1 | 2; candidates?: WatcherRecord[] }

/**
 * Resolve a watcher that is known to be backed by the Chrome extension transport.
 * When id is omitted, use the browser-level control watcher.
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
			error: 'No extension-backed watchers found. Reload the extension after `argus extension setup`, or attach a tab in the extension popup.',
			exitCode: 2,
		}
	}

	const controlWatcher = registry.watchers[CONTROL_WATCHER_ID]
	if (controlWatcher?.source === 'extension') {
		const status = await checkWatcherStatus(controlWatcher)
		if (status.ok) {
			return { ok: true, watcher: controlWatcher, registry }
		}
	}

	return {
		ok: false,
		error: 'extension-control watcher is unavailable. Reload the extension after `argus extension setup`.',
		exitCode: 2,
		candidates: extensionWatchers,
	}
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
