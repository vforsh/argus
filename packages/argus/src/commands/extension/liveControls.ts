import type { ApiResult, ExtensionDiagnosticsResponse, StatusResponse, WatcherRecord } from '@vforsh/argus-core'
import { formatError } from '../../cli/parse.js'
import { fetchWatcherJson } from '../../watchers/requestWatcher.js'

/**
 * Discovery of extension control watchers: one per browser running the extension.
 *
 * A registry record only claims a control exists. A control counts as live when its process
 * answers `/status` with the record's identity; its role comes from the record (older hosts
 * didn't write one, so for them it is probed through the control-only diagnostics route).
 */

/** A control watcher that answered, with what it reported about itself and its browser. */
export type LiveControl = {
	watcher: WatcherRecord
	/** Watcher package version of the running host (`/status.watcherVersion`). */
	watcherVersion: string | null
	/** Extension diagnostics; fetched when browser identity was requested (and always for older hosts). */
	diagnostics: ExtensionDiagnosticsResponse | null
}

/** A control record whose process didn't answer, or answered as someone else. Its browser's state is unknown. */
export type UnreachableControl = { watcher: WatcherRecord; error: string }

export type ControlProbe = { live: LiveControl[]; unreachable: UnreachableControl[] }

type ProbeOutcome = { kind: 'live'; control: LiveControl } | { kind: 'unreachable'; error: string } | { kind: 'not_control' }

/** A watcher offered as a choice in a resolution failure, with what its host reported (when it answered). */
export type ExtensionWatcherCandidate = WatcherRecord & {
	watcherVersion?: string | null
	browserInstanceId?: string | null
	browserLabel?: string | null
}

/**
 * Probe every possible control among `watchers` in parallel. Tab records are skipped by role.
 * @param options.browser Also fetch extension diagnostics, which carry the browser instance id.
 */
export const probeControls = async (watchers: WatcherRecord[], options: { browser?: boolean } = {}): Promise<ControlProbe> => {
	const candidates = watchers.filter((watcher) => watcher.source === 'extension' && readExtensionRole(watcher) !== 'tab')
	const outcomes = await Promise.all(candidates.map(async (watcher) => ({ watcher, outcome: await probeControl(watcher, options) })))

	const probe: ControlProbe = { live: [], unreachable: [] }
	for (const { watcher, outcome } of outcomes) {
		if (outcome.kind === 'live') probe.live.push(outcome.control)
		if (outcome.kind === 'unreachable') probe.unreachable.push({ watcher, error: outcome.error })
	}
	return probe
}

/** Probe one record: is its process answering, and is it a control? */
export const probeControl = async (watcher: WatcherRecord, options: { browser?: boolean } = {}): Promise<ProbeOutcome> => {
	let status: StatusResponse
	try {
		status = await fetchWatcherJson<StatusResponse>(watcher, { path: '/status', timeoutMs: 1_500 })
	} catch (error) {
		return { kind: 'unreachable', error: formatError(error) }
	}
	const identityError = describeIdentityMismatch(watcher, status)
	if (identityError) {
		return { kind: 'unreachable', error: identityError }
	}

	const role = readExtensionRole(watcher)
	if (role === 'tab') {
		return { kind: 'not_control' }
	}
	const watcherVersion = status.watcherVersion ?? null
	if (role === 'control' && !options.browser) {
		return { kind: 'live', control: { watcher, watcherVersion, diagnostics: null } }
	}

	const diagnostics = await fetchControlDiagnostics(watcher)
	if (role == null && !diagnostics) {
		// An older host's tab watcher answers /status but not the control-only diagnostics route.
		return { kind: 'not_control' }
	}
	return { kind: 'live', control: { watcher, watcherVersion, diagnostics } }
}

/** Diagnostics, or `null` when the route fails: the control answered, but its extension bridge may be down. */
export const fetchControlDiagnostics = async (watcher: WatcherRecord): Promise<ExtensionDiagnosticsResponse | null> => {
	try {
		const response = await fetchWatcherJson<ApiResult<ExtensionDiagnosticsResponse>>(watcher, {
			path: '/extension/diagnostics',
			timeoutMs: 1_500,
			returnErrorResponse: true,
		})
		return response.ok ? response : null
	} catch {
		return null
	}
}

/** The browser instance behind a control, when its extension reported one. */
export const getBrowserInstanceId = (control: LiveControl): string | null => control.diagnostics?.extension.instanceId ?? null

/** A live control as a resolution-failure candidate. */
export const toCandidate = (control: LiveControl, labels: Record<string, { label: string }> = {}): ExtensionWatcherCandidate => {
	const instanceId = getBrowserInstanceId(control)
	return {
		...control.watcher,
		watcherVersion: control.watcherVersion,
		browserInstanceId: instanceId,
		browserLabel: instanceId ? (labels[instanceId]?.label ?? null) : null,
	}
}

/**
 * A record's extension role as written by its host, or `null` for records from older hosts that
 * predate `extensionRole` (their role is only learnable by probing).
 */
export const readExtensionRole = (watcher: WatcherRecord): WatcherRecord['extensionRole'] | null =>
	watcher.source === 'extension' ? (watcher.extensionRole ?? null) : null

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
