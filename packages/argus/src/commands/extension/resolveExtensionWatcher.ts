import type { StatusResponse, RegistryV1, WatcherRecord, ApiResult, ExtensionDiagnosticsResponse, ArgusErrorCode } from '@vforsh/argus-core'
import { pruneRegistry } from '../../registry.js'
import { fetchWatcherJson } from '../../watchers/requestWatcher.js'
import { formatError } from '../../cli/parse.js'

export type ResolveExtensionWatcherInput = {
	id?: string
}

/** A watcher offered as a choice in a resolution failure, with the host version it reported (when it answered). */
export type ExtensionWatcherCandidate = WatcherRecord & { watcherVersion?: string | null }

export type ResolveExtensionWatcherResult =
	| { ok: true; watcher: WatcherRecord; registry: RegistryV1 }
	| { ok: false; error: string; exitCode: 1 | 2; code?: ArgusErrorCode; candidates?: ExtensionWatcherCandidate[] }

/**
 * Resolve a live extension control watcher. A tab watcher cannot list or attach
 * tabs, even though both kinds share the same registry source.
 *
 * Without `--id`, every live control is a candidate: exactly one is used, several fail with
 * `ambiguous_control`. Picking the conventional `extension-control` name instead silently sent
 * commands to whichever browser happened to register first.
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

	const controls = await findLiveControlWatchers(extensionWatchers)
	if (controls.length === 1) {
		return { ok: true, watcher: controls[0], registry }
	}
	if (controls.length > 1) {
		return {
			ok: false,
			code: 'ambiguous_control',
			error: `Multiple extension control watchers are live (${controls.map((watcher) => watcher.id).join(', ')}); one per browser. Pass --id <controlWatcherId> to pick one.`,
			exitCode: 2,
			candidates: controls,
		}
	}

	return {
		ok: false,
		error: 'No live extension control watcher. Reload the extension after `argus extension setup`.',
		exitCode: 2,
		candidates: extensionWatchers,
	}
}

/**
 * A record's extension role as written by its host, or `null` for records from older hosts that
 * predate `extensionRole` (their role is only learnable by probing).
 */
export const readExtensionRole = (watcher: WatcherRecord): WatcherRecord['extensionRole'] | null =>
	watcher.source === 'extension' ? (watcher.extensionRole ?? null) : null

const getExtensionWatchers = (watchers: WatcherRecord[]): WatcherRecord[] => watchers.filter((watcher) => watcher.source === 'extension')

/** Probe every possible control in parallel; tab records are skipped by role, legacy records by probe. */
const findLiveControlWatchers = async (watchers: WatcherRecord[]): Promise<ExtensionWatcherCandidate[]> => {
	const probed = await Promise.all(
		watchers
			.filter((watcher) => readExtensionRole(watcher) !== 'tab')
			.map(async (watcher) => ({ watcher, status: await checkWatcherStatus(watcher) })),
	)
	return probed.flatMap(({ watcher, status }) => (status.ok && status.control ? [{ ...watcher, watcherVersion: status.watcherVersion }] : []))
}

type WatcherStatusCheck = { ok: true; control: boolean; watcherVersion: string | null } | { ok: false; error: string }

/**
 * Confirm the record's process answers, then learn its role: from the record when the host wrote
 * one, otherwise (older hosts) by probing the control-only diagnostics route.
 */
const checkWatcherStatus = async (watcher: WatcherRecord): Promise<WatcherStatusCheck> => {
	try {
		const status = await fetchWatcherJson<StatusResponse>(watcher, { path: '/status', timeoutMs: 1_500 })
		const identityError = describeIdentityMismatch(watcher, status)
		if (identityError) {
			return { ok: false, error: identityError }
		}
		const watcherVersion = status.watcherVersion ?? null
		const role = readExtensionRole(watcher)
		if (role) {
			return { ok: true, control: role === 'control', watcherVersion }
		}
		const diagnostics = await fetchWatcherJson<ApiResult<ExtensionDiagnosticsResponse>>(watcher, {
			path: '/extension/diagnostics',
			timeoutMs: 1_500,
			returnErrorResponse: true,
		})
		return { ok: true, control: diagnostics.ok, watcherVersion }
	} catch (error) {
		return { ok: false, error: formatError(error) }
	}
}

/** `id` and `pid` can't tell two processes sharing one id apart; `ownerId` can, when both sides report it. */
export const describeIdentityMismatch = (watcher: WatcherRecord, status: StatusResponse): string | null => {
	if ((status.id && status.id !== watcher.id) || (status.pid && status.pid !== watcher.pid)) {
		return 'HTTP identity does not match the registry entry'
	}
	if (watcher.ownerId && status.ownerId && status.ownerId !== watcher.ownerId) {
		return 'HTTP owner does not match the registry entry'
	}
	return null
}
