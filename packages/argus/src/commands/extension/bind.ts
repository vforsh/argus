import type {
	ApiResult,
	ExtensionBrowserTab,
	NavigateResponse,
	StatusResponse,
	VisibilityPolicy,
	VisibilityResponse,
	WatcherRecord,
} from '@vforsh/argus-core'
import { DEFAULT_NAVIGATION_TIMEOUT_MS, delay, isBindTicket } from '@vforsh/argus-core'
import { formatError } from '../../cli/parse.js'
import { createOutput, type Output } from '../../output/io.js'
import { pruneRegistry } from '../../registry.js'
import { buildWatcherUrl, fetchWatcherJson } from '../../watchers/requestWatcher.js'
import { claimBindTicket, createBindTicket, releaseBindTicket, type BindTicket } from './bindTickets.js'
import { readBrowserLabels, setBrowserLabel } from './browserLabels.js'
import { emitFailure } from './failures.js'
import { getBrowserInstanceId, probeControls, type LiveControl, type UnreachableControl } from './liveControls.js'
import { fetchExtensionTabs } from './tabSelection.js'
import { resolveOrAttachExtensionTabWatcher } from './tabWatcher.js'

/**
 * `argus ext bind prepare` / `argus ext bind <ticket>`: bind exactly the tab an agent opened,
 * across every browser running the extension (flow: `protocol/http/bind.ts`).
 */

export type ExtensionBindPrepareOptions = {
	to?: string
	json?: boolean
}

/** Create a ticket and the waiting-page URL the agent opens in the tab it wants bound. */
export const runExtensionBindPrepare = async (options: ExtensionBindPrepareOptions): Promise<void> => {
	const output = createOutput(options)
	const destination = parseDestination(options.to)
	if (!destination.ok) {
		emitFailure(output, { error: destination.error, code: 'invalid_request', exitCode: 2 })
		return
	}

	// Any live control can serve the static page: plain HTTP on 127.0.0.1, reachable from every local
	// browser. Hosts that predate registry ownership (no `ownerId`) also predate the /bind route.
	const { live } = await probeControls(Object.values((await pruneRegistry()).watchers))
	const server = live.find((control) => control.watcher.ownerId != null)?.watcher
	if (!server) {
		emitFailure(output, {
			error:
				live.length > 0
					? 'Live extension controls run an older native host without the bind page. Reload the extension at chrome://extensions or restart the browser.'
					: 'No live extension control watcher to serve the bind page. Reload the extension after `argus extension setup`.',
			exitCode: 2,
		})
		return
	}

	const ticket = await createBindTicket(destination.url)
	const bindUrl = buildWatcherUrl(server, '/bind', new URLSearchParams({ ticket: ticket.ticket }))
	if (options.json) {
		output.writeJson({ ok: true, ticket: ticket.ticket, bindUrl, destination: ticket.destination, expiresAt: ticket.expiresAt })
		return
	}
	output.writeHuman(`ticket   ${ticket.ticket}`)
	output.writeHuman(`bindUrl  ${bindUrl}`)
	output.writeHuman(`expires  ${new Date(ticket.expiresAt).toISOString()}`)
	output.writeHuman(`Open bindUrl in the tab to bind, then run: argus ext bind ${ticket.ticket}`)
}

const parseDestination = (value: string | undefined): { ok: true; url: string } | { ok: false; error: string } => {
	const trimmed = value?.trim()
	if (!trimmed) {
		return { ok: false, error: '--to <destinationUrl> is required.' }
	}
	try {
		const url = new URL(trimmed)
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			return { ok: false, error: `--to must be an http(s) URL, got ${url.protocol}` }
		}
		return { ok: true, url: url.href }
	} catch {
		return { ok: false, error: `--to is not a valid URL: ${trimmed}` }
	}
}

export type ExtensionBindOptions = {
	as?: string
	label?: string
	visibility?: string
	json?: boolean
}

/** What a successful bind reports. `targetReady` is debugger readiness, not application health. */
export type ExtensionBindResult = {
	ok: true
	watcherId: string
	tabId: number
	url: string
	control: { id: string; pid: number }
	browser: { instanceId: string | null; label: string | null }
	attached: true
	/** True when the tab already had a watcher; binding reused it instead of attaching another. */
	reused: boolean
	targetReady: boolean | null
	/** `foreground`/`background` while a shown lock is held, else `default`. */
	visibility: VisibilityPolicy | 'default'
}

const VISIBILITY_CHOICES = ['foreground', 'background'] as const satisfies readonly VisibilityPolicy[]

/**
 * Bind the one tab whose URL carries `ticket`: attach (or reuse its watcher), navigate it to the
 * ticket's destination, and wait for the debugger target. The ticket is spent only on success.
 */
export const runExtensionBind = async (ticket: string, options: ExtensionBindOptions): Promise<void> => {
	const output = createOutput(options)
	if (!isBindTicket(ticket)) {
		emitFailure(output, {
			error: `Not a bind ticket: ${ticket}. Run \`argus ext bind prepare --to <url>\` first.`,
			code: 'invalid_request',
			exitCode: 2,
		})
		return
	}
	const visibility = options.visibility?.trim() || undefined
	if (visibility !== undefined && !isVisibilityChoice(visibility)) {
		emitFailure(output, { error: `--visibility must be one of: ${VISIBILITY_CHOICES.join(', ')}`, code: 'invalid_request', exitCode: 2 })
		return
	}

	const claim = await claimBindTicket(ticket)
	if (!claim.ok) {
		emitFailure(output, { error: claim.error, code: claim.code, exitCode: 2 })
		return
	}

	const result = await bindClaimedTicket(claim.ticket, { ...options, visibility }, output).catch((error: unknown) => {
		emitFailure(output, { error: `Bind failed: ${formatError(error)}` })
		return null
	})
	if (!result) {
		await releaseBindTicket(ticket)
		return
	}

	if (options.json) {
		output.writeJson(result)
		return
	}
	output.writeHuman(`${result.reused ? 'reused' : 'bound'} ${result.watcherId}`)
	output.writeHuman(`  tab ${result.tabId} via ${result.control.id}: ${result.url}`)
	output.writeHuman(`  browser ${result.browser.label ?? 'unlabeled'} (${result.browser.instanceId ?? 'unknown instance'})`)
}

const isVisibilityChoice = (value: string): value is VisibilityPolicy => (VISIBILITY_CHOICES as readonly string[]).includes(value)

type BindInput = Omit<ExtensionBindOptions, 'visibility'> & { visibility?: VisibilityPolicy }

/** @returns The result, or `null` after reporting a failure. */
const bindClaimedTicket = async (ticket: BindTicket, options: BindInput, output: Output): Promise<ExtensionBindResult | null> => {
	const located = await findTicketTab(ticket.ticket, output)
	if (!located) {
		return null
	}
	const { control, tab } = located
	const instanceId = getBrowserInstanceId(control)
	if (options.label && !instanceId) {
		emitFailure(output, {
			error: `${control.watcher.id}'s extension reports no browser instance id, so --label can't be recorded. Reload the extension to update it.`,
			exitCode: 2,
		})
		return null
	}

	const reused = tab.attached && tab.watcherId != null
	const bound = await resolveOrAttachExtensionTabWatcher({ id: control.watcher.id, tab: tab.tabId, as: options.as, json: options.json }, output, {
		missingSelectorReason: 'unreachable: the tab id is always given',
	})
	if (!bound) {
		return null
	}

	const navigated = await navigateTo(bound.watcher, ticket.destination)
	if (!navigated.ok) {
		emitFailure(output, { error: `${bound.watcher.id}: failed to open ${ticket.destination} (${navigated.error})` })
		return null
	}
	const visibility = await applyVisibility(bound.watcher, options.visibility)
	if (!visibility.ok) {
		emitFailure(output, { error: `${bound.watcher.id}: failed to set visibility (${visibility.error})` })
		return null
	}

	if (options.label && instanceId) {
		await setBrowserLabel(instanceId, options.label, 'bind')
	}
	const label = instanceId ? ((await readBrowserLabels())[instanceId]?.label ?? null) : null
	return {
		ok: true,
		watcherId: bound.watcher.id,
		tabId: tab.tabId,
		url: navigated.url,
		control: { id: control.watcher.id, pid: control.watcher.pid },
		browser: { instanceId, label },
		attached: true,
		reused,
		targetReady: await waitForTargetReady(bound.watcher),
		visibility: visibility.value,
	}
}

/**
 * Ask every live control for the tab carrying the ticket. Exactly one match binds; none or several
 * fail. An unreachable control means its browser's tabs are unknown, not that the tab is missing,
 * so the error names them separately.
 */
const findTicketTab = async (ticket: string, output: Output): Promise<{ control: LiveControl; tab: ExtensionBrowserTab } | null> => {
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

const navigateTo = async (watcher: WatcherRecord, url: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> => {
	try {
		const response = await fetchWatcherJson<ApiResult<NavigateResponse>>(watcher, {
			path: '/navigate',
			method: 'POST',
			body: { url },
			timeoutMs: DEFAULT_NAVIGATION_TIMEOUT_MS + 5_000,
			returnErrorResponse: true,
		})
		return response.ok ? { ok: true, url: response.url } : { ok: false, error: response.error.message }
	} catch (error) {
		return { ok: false, error: formatError(error) }
	}
}

/** Apply `--visibility` (a shown lock with that policy), or just report the current state. */
const applyVisibility = async (
	watcher: WatcherRecord,
	policy: VisibilityPolicy | undefined,
): Promise<{ ok: true; value: ExtensionBindResult['visibility'] } | { ok: false; error: string }> => {
	try {
		const response = await fetchWatcherJson<ApiResult<VisibilityResponse>>(watcher, {
			path: '/visibility',
			...(policy ? { method: 'POST' as const, body: { action: 'show', policy } } : {}),
			timeoutMs: 5_000,
			returnErrorResponse: true,
		})
		if (!response.ok) {
			return { ok: false, error: response.error.message }
		}
		return { ok: true, value: response.state === 'shown' ? response.policy : 'default' }
	} catch (error) {
		return { ok: false, error: formatError(error) }
	}
}

const TARGET_READY_TIMEOUT_MS = 5_000

/**
 * The new document's target reports readiness shortly after the navigation response (`null` while
 * unknown). Returns the last value seen when it doesn't become ready in time.
 */
const waitForTargetReady = async (watcher: WatcherRecord): Promise<boolean | null> => {
	const deadline = Date.now() + TARGET_READY_TIMEOUT_MS
	let last: boolean | null = null
	while (Date.now() < deadline) {
		try {
			const status = await fetchWatcherJson<StatusResponse>(watcher, { path: '/status', timeoutMs: 1_500 })
			last = status.targetReady ?? null
			if (last === true) {
				return last
			}
		} catch {
			// Transient while the tab navigates; retry until the deadline.
		}
		await delay(200)
	}
	return last
}
