import type { RegistryV1, WatcherRecord, ArgusErrorCode } from '@vforsh/argus-core'
import { pruneRegistry } from '../../registry.js'
import { formatError } from '../../cli/parse.js'
import { readBrowserLabels } from './browserLabels.js'
import { getBrowserInstanceId, probeControl, probeControls, toCandidate, type ExtensionWatcherCandidate } from './liveControls.js'

export type { ExtensionWatcherCandidate } from './liveControls.js'

/** How a command picks the browser it acts on: a control watcher id, or a browser label / instance id. */
export type ControlSelector = {
	id?: string
	browser?: string
}

export type ResolveExtensionWatcherResult =
	| { ok: true; watcher: WatcherRecord; registry: RegistryV1 }
	| { ok: false; error: string; exitCode: 1 | 2; code?: ArgusErrorCode; candidates?: ExtensionWatcherCandidate[] }

type ResolveFailure = Extract<ResolveExtensionWatcherResult, { ok: false }>

/**
 * Resolve a live extension control watcher. A tab watcher cannot list or attach
 * tabs, even though both kinds share the same registry source.
 *
 * Without a selector, every live control is a candidate: exactly one is used, several fail with
 * `ambiguous_control`. Picking the conventional `extension-control` name instead silently sent
 * commands to whichever browser happened to register first.
 */
export const resolveExtensionWatcher = async (input: ControlSelector): Promise<ResolveExtensionWatcherResult> => {
	if (input.id && input.browser) {
		return { ok: false, error: 'Use either --id or --browser, not both.', exitCode: 2 }
	}

	let registry: RegistryV1
	try {
		registry = await pruneRegistry()
	} catch (error) {
		return { ok: false, error: `Failed to load registry: ${formatError(error)}`, exitCode: 1 }
	}

	const allWatchers = Object.values(registry.watchers)
	if (input.id) {
		const resolved = await resolveById(registry, input.id, allWatchers)
		return resolved.ok ? { ...resolved, registry } : resolved
	}

	const extensionWatchers = allWatchers.filter((watcher) => watcher.source === 'extension')
	if (extensionWatchers.length === 0) {
		return {
			ok: false,
			error: 'No extension-backed watchers found. Reload the extension after `argus extension setup`, or attach a tab in the extension popup.',
			exitCode: 2,
		}
	}

	const resolved = input.browser ? await resolveByBrowser(extensionWatchers, input.browser) : await resolveOnlyControl(extensionWatchers)
	return resolved.ok ? { ...resolved, registry } : resolved
}

const resolveById = async (
	registry: RegistryV1,
	id: string,
	allWatchers: WatcherRecord[],
): Promise<{ ok: true; watcher: WatcherRecord } | ResolveFailure> => {
	const watcher = registry.watchers[id]
	if (!watcher) {
		return { ok: false, error: `Watcher not found: ${id}`, exitCode: 2, candidates: allWatchers }
	}
	if (watcher.source !== 'extension') {
		return {
			ok: false,
			error: `Watcher ${watcher.id} is not extension-backed.`,
			exitCode: 2,
			candidates: allWatchers.filter((candidate) => candidate.source === 'extension'),
		}
	}
	const outcome = await probeControl(watcher)
	if (outcome.kind === 'unreachable') {
		return { ok: false, error: `Control watcher ${watcher.id} is unavailable: ${outcome.error}`, exitCode: 2 }
	}
	if (outcome.kind === 'not_control') {
		return { ok: false, error: `Watcher ${watcher.id} is an extension tab watcher, not a control watcher.`, exitCode: 2 }
	}
	return { ok: true, watcher }
}

const resolveOnlyControl = async (watchers: WatcherRecord[]): Promise<{ ok: true; watcher: WatcherRecord } | ResolveFailure> => {
	const { live } = await probeControls(watchers)
	if (live.length === 1) {
		return { ok: true, watcher: live[0].watcher }
	}
	if (live.length > 1) {
		return {
			ok: false,
			code: 'ambiguous_control',
			error: `Multiple extension control watchers are live (${live.map((control) => control.watcher.id).join(', ')}); one per browser. Pass --id <controlWatcherId> or --browser <label> to pick one.`,
			exitCode: 2,
			candidates: live.map((control) => toCandidate(control)),
		}
	}
	return {
		ok: false,
		error: 'No live extension control watcher. Reload the extension after `argus extension setup`.',
		exitCode: 2,
		candidates: watchers,
	}
}

/** `browser` matches an instance id exactly, or the label assigned to one. */
const resolveByBrowser = async (watchers: WatcherRecord[], browser: string): Promise<{ ok: true; watcher: WatcherRecord } | ResolveFailure> => {
	const [{ live }, labels] = await Promise.all([probeControls(watchers, { browser: true }), readBrowserLabels()])
	const matches = live.filter((control) => {
		const instanceId = getBrowserInstanceId(control)
		return instanceId != null && (instanceId === browser || labels[instanceId]?.label === browser)
	})

	if (matches.length === 1) {
		return { ok: true, watcher: matches[0].watcher }
	}
	if (matches.length > 1) {
		return {
			ok: false,
			code: 'ambiguous_browser',
			error: `Browser "${browser}" matches ${matches.length} live browser instances (${matches.map((control) => control.watcher.id).join(', ')}). Relabel one with \`argus ext browsers label <instanceId> <label>\`, or pass an instance id.`,
			exitCode: 2,
			candidates: matches.map((control) => toCandidate(control, labels)),
		}
	}
	return {
		ok: false,
		code: 'not_found',
		error: `No live browser is labeled or identified as "${browser}". Run \`argus ext browsers\` to list instances.`,
		exitCode: 2,
		candidates: live.map((control) => toCandidate(control, labels)),
	}
}
