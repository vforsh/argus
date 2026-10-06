import type { ApiResult, ErrorResponse, ExtensionBrowserTab, ExtensionDiagnosticsResponse, WatcherRecord } from '@vforsh/argus-core'
import type { Output } from '../../output/io.js'
import { pruneRegistry } from '../../registry.js'
import type { BindCheckpoint } from './bindTickets.js'
import { emitFailure } from './failures.js'
import { fetchControlDiagnostics, probeControls, type LiveControl, type UnreachableControl } from './liveControls.js'
import { fetchExtensionTabs } from './tabSelection.js'
import { readPinnedWatcherStatus } from './watcherIdentity.js'

/**
 * Ask every live control for the tab carrying the ticket. Exactly one match binds; none or several
 * fail. An unreachable control means its browser's tabs are unknown, not that the tab is missing,
 * so the error names them separately.
 */
export const findTicketTab = async (ticket: string, output: Output): Promise<{ control: LiveControl; tab: ExtensionBrowserTab } | null> => {
	const probe = await probeControls(Object.values((await pruneRegistry()).watchers), { browser: true })
	const searched = await Promise.all(
		probe.live.map(async (control) => ({ control, tabs: await fetchExtensionTabs(control.watcher, { kind: 'query', url: ticket }) })),
	)

	const unreachable: UnreachableControl[] = [...probe.unreachable]
	const matches: Array<{ control: LiveControl; tab: ExtensionBrowserTab }> = []
	for (const { control, tabs } of searched) {
		if (!tabs.ok) {
			unreachable.push({ watcher: control.watcher, error: tabs.error })
			continue
		}
		matches.push(...tabs.tabs.map((tab) => ({ control, tab })))
	}

	if (matches.length === 1) {
		return matches[0]
	}

	const answered = searched.filter(({ tabs }) => tabs.ok).map(({ control }) => control.watcher.id)
	const details = {
		searched: answered,
		unreachable: unreachable.map(({ watcher, error }) => ({ id: watcher.id, error })),
		matches: matches.map(({ control, tab }) => ({ controlId: control.watcher.id, tabId: tab.tabId, url: tab.url })),
	}
	if (matches.length > 1) {
		emitFailure(output, {
			error: `${matches.length} tabs carry ticket ${ticket}; refusing to pick one. Close the extra tabs, or prepare a new ticket and open it once.`,
			code: 'ambiguous_tab',
			exitCode: 2,
			hints: details.matches.map((match) => `  ${match.controlId} tab ${match.tabId}: ${match.url}`),
			details,
		})
		return null
	}

	const unknown = unreachable.length > 0 ? ` Unreachable, so their tabs are unknown: ${unreachable.map(describeUnreachable).join('; ')}.` : ''
	emitFailure(output, {
		error: `No tab's URL contains ticket ${ticket}. Searched: ${answered.length > 0 ? answered.join(', ') : 'no live controls'}.${unknown} Open the bindUrl first.`,
		code: 'not_found',
		exitCode: 2,
		details,
	})
	return null
}

const describeUnreachable = ({ watcher, error }: UnreachableControl): string => `${watcher.id} (${error})`

/** Verify the pinned control run and browser connection before attaching or resuming. */
export const verifyBindControl = async (watcher: WatcherRecord, instanceId: string | null): Promise<ApiResult<ExtensionDiagnosticsResponse>> => {
	const status = await readPinnedWatcherStatus(watcher)
	if (!status.ok) return status
	const diagnostics = await fetchControlDiagnostics(watcher)
	if (!diagnostics || !diagnostics.control.connected) {
		return {
			ok: false,
			error: { code: 'not_available', message: `Control ${watcher.id} cannot confirm its browser connection. Retry after reconnecting.` },
		}
	}
	if ((diagnostics.extension.instanceId ?? null) !== instanceId) {
		return changedBinding(`Control ${watcher.id} now reports a different browser instance.`)
	}
	return diagnostics
}

/**
 * Confirm the exact control/browser/tab/watcher relationship before side effects. On first bind,
 * also require the URL locator; retries use the durable watcher identity instead of rediscovery.
 */
export const verifyBindCheckpoint = async (binding: BindCheckpoint, ticket?: string): Promise<ErrorResponse | null> => {
	const diagnostics = await verifyBindControl(binding.control, binding.browserInstanceId)
	if (!diagnostics.ok) return diagnostics
	const tabs = await fetchExtensionTabs(binding.control, { kind: 'tab', tabId: binding.tab.tabId })
	if (!tabs.ok) return { ok: false, error: { message: tabs.error } }
	const tab = tabs.tabs.find((candidate) => candidate.tabId === binding.tab.tabId)
	if (!tab)
		return { ok: false, error: { code: 'not_found', message: `Bound tab ${binding.tab.tabId} is no longer available. Prepare a new ticket.` } }
	if (!tab.attached || tab.watcherId !== binding.watcher.id || (ticket && !tab.url.includes(ticket))) {
		return changedBinding(`Tab ${tab.tabId} no longer has the selected ticket/watcher binding.`)
	}
	const bridge = diagnostics.tabWatchers.find((candidate) => candidate.tabId === tab.tabId)
	if (
		!bridge?.connected ||
		bridge.watcherId !== binding.watcher.id ||
		bridge.pid !== binding.watcher.pid ||
		bridge.watcherHost !== binding.watcher.host ||
		bridge.watcherPort !== binding.watcher.port
	) {
		return changedBinding(`Control ${binding.control.id} cannot confirm watcher ${binding.watcher.id}'s endpoint for tab ${tab.tabId}.`)
	}
	const status = await readPinnedWatcherStatus(binding.watcher)
	return status.ok ? null : status
}

const changedBinding = (message: string): ErrorResponse => ({
	ok: false,
	error: { code: 'registration_conflict', message: `${message} Refusing to bind a replacement; prepare a new ticket.` },
})
