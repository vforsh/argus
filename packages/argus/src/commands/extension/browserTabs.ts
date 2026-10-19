import type { ExtensionBrowserTab, RegistryV1, WatcherRecord } from '@vforsh/argus-core'
import { loadActiveRegistry } from '../../registry.js'
import { readBrowserLabels } from './browserLabels.js'
import { fetchControlDiagnostics, type ExtensionWatcherCandidate } from './liveControls.js'
import { resolveExtensionWatcher, type ControlSelector, type ResolveExtensionWatcherResult } from './resolveExtensionWatcher.js'
import { fetchExtensionTabs, isExactUrlMatch, type ExtensionTabsFetchResult, type TabSelector } from './tabSelection.js'

/**
 * Tab lookup across every live browser.
 *
 * Each browser running the extension has its own control watcher, so with two browsers open a
 * bare `ext tabs` / `ext use --url` used to fail with `ambiguous_control` even when only one of
 * them could possibly hold the tab (the other might have no tabs at all). These helpers ask every
 * control and only stay ambiguous when several browsers really answer with matches.
 */

/** One browser's answer to a tab query. */
export type BrowserTabGroup = {
	control: ExtensionWatcherCandidate
	/** Label assigned to the browser instance, when one was assigned. */
	label: string | null
	tabs: ExtensionBrowserTab[]
	/** Set when the control failed to list tabs; `tabs` is then empty. */
	error?: string
}

export type ControlTabsResult =
	/**
	 * Exactly one browser is in play: the selected control, or the only one with matching tabs.
	 * `warnings` names other browsers that could not be asked, so the choice is not silent.
	 */
	| {
			kind: 'single'
			watcher: WatcherRecord
			registry: RegistryV1
			tabs: ExtensionBrowserTab[]
			fetchFailure?: Extract<ExtensionTabsFetchResult, { ok: false }>
			warnings: string[]
	  }
	/** Several live browsers and no selector narrowed them to one; every browser's tabs. */
	| { kind: 'grouped'; groups: BrowserTabGroup[] }
	| { kind: 'failed'; failure: Extract<ResolveExtensionWatcherResult, { ok: false }> }

/**
 * Resolve the browser for a tab query and list its tabs.
 *
 * `--id` / `--browser` pin the control as before. Without them, several live controls are
 * resolved by asking each: a selector that matches tabs in exactly one browser picks that
 * browser (an exact `--url` match breaks a tie between browsers, as it does between tabs);
 * otherwise the per-browser groups come back so the caller can list or report them.
 * `accept` narrows each browser's tabs further before that choice (e.g. exact URL for `--open`).
 */
export const resolveControlTabs = async (
	input: ControlSelector,
	selector: TabSelector,
	options: { accept?: (tab: ExtensionBrowserTab) => boolean } = {},
): Promise<ControlTabsResult> => {
	const accept = options.accept ?? (() => true)
	const resolved = await resolveExtensionWatcher(input)
	if (resolved.ok) {
		const tabs = await fetchExtensionTabs(resolved.watcher, selector)
		const base = { kind: 'single' as const, watcher: resolved.watcher, registry: resolved.registry, warnings: [] }
		return tabs.ok ? { ...base, tabs: tabs.tabs.filter(accept) } : { ...base, tabs: [], fetchFailure: tabs }
	}
	if (resolved.code !== 'ambiguous_control' || !resolved.candidates?.length) {
		return { kind: 'failed', failure: resolved }
	}

	const groups = (await fetchTabGroups(resolved.candidates, selector)).map((group) => ({ ...group, tabs: group.tabs.filter(accept) }))
	const chosen = isNarrowingSelector(selector) ? chooseGroup(groups, selector) : null
	if (!chosen) {
		return { kind: 'grouped', groups }
	}
	const registry = await resolveRegistry(chosen.control)
	if (!registry) {
		return {
			kind: 'failed',
			failure: { ok: false, error: `Control watcher ${chosen.control.id} disappeared from the registry while resolving tabs. Retry.`, exitCode: 1 },
		}
	}
	const warnings = groups
		.filter((group) => group.error)
		.map((group) => `${formatBrowserGroupName(group)} could not list tabs (${group.error}); using ${formatBrowserGroupName(chosen)}.`)
	return { kind: 'single', watcher: registry.watcher, registry: registry.registry, tabs: chosen.tabs, warnings }
}

/** The one browser with matching tabs, or with the only exact `--url` match among several. */
const chooseGroup = (groups: BrowserTabGroup[], selector: TabSelector): BrowserTabGroup | null => {
	const withTabs = groups.filter((group) => group.tabs.length > 0)
	if (withTabs.length === 1) return withTabs[0]
	if (withTabs.length < 2 || selector.kind !== 'query' || !selector.url) return null
	const pattern = selector.url
	const exact = withTabs.filter((group) => group.tabs.some((tab) => isExactUrlMatch(tab.url, pattern)))
	return exact.length === 1 ? exact[0] : null
}

/** Tab-id lookups and url/title queries narrow the browsers; an empty query lists everything. */
const isNarrowingSelector = (selector: TabSelector): boolean => selector.kind === 'tab' || Boolean(selector.url || selector.title)

const fetchTabGroups = async (controls: readonly ExtensionWatcherCandidate[], selector: TabSelector): Promise<BrowserTabGroup[]> => {
	const labels = await readBrowserLabels().catch(() => ({}) as Awaited<ReturnType<typeof readBrowserLabels>>)
	return Promise.all(
		controls.map(async (control): Promise<BrowserTabGroup> => {
			const [tabs, instanceId] = await Promise.all([fetchExtensionTabs(control, selector), resolveInstanceId(control)])
			const label = control.browserLabel ?? (instanceId ? (labels[instanceId]?.label ?? null) : null)
			if (!tabs.ok) {
				return { control, label, tabs: [], error: tabs.error }
			}
			const matching = selector.kind === 'tab' ? tabs.tabs.filter((tab) => tab.tabId === selector.tabId) : tabs.tabs
			return { control, label, tabs: matching }
		}),
	)
}

const resolveInstanceId = async (control: ExtensionWatcherCandidate): Promise<string | null> =>
	control.browserInstanceId ?? (await fetchControlDiagnostics(control))?.extension.instanceId ?? null

const resolveRegistry = async (control: ExtensionWatcherCandidate): Promise<{ registry: RegistryV1; watcher: WatcherRecord } | null> => {
	const registry = await loadActiveRegistry().catch(() => null)
	const watcher = registry?.watchers[control.id]
	return registry && watcher ? { registry, watcher } : null
}

/** `extension-control (codex-teachers)` */
export const formatBrowserGroupName = (group: Pick<BrowserTabGroup, 'control' | 'label'>): string =>
	group.label ? `${group.control.id} (${group.label})` : group.control.id
