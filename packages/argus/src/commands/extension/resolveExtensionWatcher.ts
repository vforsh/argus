import type { StatusResponse, RegistryV1, WatcherRecord, ApiResult, ExtensionDiagnosticsResponse } from '@vforsh/argus-core'
import { pruneRegistry } from '../../registry.js'
import { fetchWatcherJson } from '../../watchers/requestWatcher.js'
import { CONTROL_WATCHER_ID } from './nativeHost.js'
import { formatError } from '../../cli/parse.js'

export type ResolveExtensionWatcherInput = {
	id?: string
}

export type ResolveExtensionWatcherResult =
	| { ok: true; watcher: WatcherRecord; registry: RegistryV1 }
	| { ok: false; error: string; exitCode: 1 | 2; candidates?: WatcherRecord[] }

/**
 * Resolve a live extension control watcher. A tab watcher cannot list or attach
 * tabs, even though both kinds share the same registry source.
 */
export const resolveExtensionWatcher = async (input: ResolveExtensionWatcherInput): Promise<ResolveExtensionWatcherResult> => {
	let registry: RegistryV1
	try {
		registry = await pruneRegistry()
	} catch (error) {
		return { ok: false, error: `Failed to load registry: ${formatError(error)}`, exitCode: 1 }
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
		const status = await checkWatcherStatus(watcher)
		if (!status.ok) return { ok: false, error: `Control watcher ${watcher.id} is unavailable: ${status.error}`, exitCode: 2 }
		if (!status.control) {
			return { ok: false, error: `Watcher ${watcher.id} is an extension tab watcher, not a control watcher.`, exitCode: 2 }
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
		if (status.ok && status.control) {
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

const checkWatcherStatus = async (watcher: WatcherRecord): Promise<{ ok: true; control: boolean } | { ok: false; error: string }> => {
	try {
		const status = await fetchWatcherJson<StatusResponse>(watcher, { path: '/status', timeoutMs: 1_500 })
		if ((status.id && status.id !== watcher.id) || (status.pid && status.pid !== watcher.pid)) {
			return { ok: false, error: 'HTTP identity does not match the registry entry' }
		}
		const diagnostics = await fetchWatcherJson<ApiResult<ExtensionDiagnosticsResponse>>(watcher, {
			path: '/extension/diagnostics',
			timeoutMs: 1_500,
			returnErrorResponse: true,
		})
		return { ok: true, control: diagnostics.ok }
	} catch (error) {
		return { ok: false, error: formatError(error) }
	}
}
