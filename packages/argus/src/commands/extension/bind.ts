import type { ApiResult, NavigateResponse, VisibilityPolicy, ErrorResponse, WatcherRecord } from '@vforsh/argus-core'
import { DEFAULT_NAVIGATION_TIMEOUT_MS, delay, isBindTicket } from '@vforsh/argus-core'
import { formatError } from '../../cli/parse.js'
import { createOutput, type Output } from '../../output/io.js'
import { loadActiveRegistry } from '../../registry.js'
import { buildWatcherUrl, fetchWatcherJson } from '../../watchers/requestWatcher.js'
import {
	checkpointBindTicket,
	claimBindTicket,
	completeBindTicket,
	createBindTicket,
	releaseBindTicket,
	type BindCheckpoint,
	type BindTicket,
} from './bindTickets.js'
import { findBindPageServer } from './bindPageServer.js'
import { findTicketTab, verifyBindCheckpoint, verifyBindControl } from './bindTarget.js'
import { readBrowserLabels, setBrowserLabel } from './browserLabels.js'
import { emitFailure } from './failures.js'
import { getBrowserInstanceId, probeControls } from './liveControls.js'
import { attachResolvedExtensionTabWatcher } from './tabWatcher.js'
import { readPinnedWatcherStatus } from './watcherIdentity.js'
import { requestVisibility } from '../visibility.js'

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

	const { live } = await probeControls(Object.values((await loadActiveRegistry()).watchers))
	const server = await findBindPageServer(live)
	if (!server) {
		emitFailure(output, {
			error:
				live.length > 0
					? 'No live extension control serves a supported bind page. Update the native host, then reload the extension at chrome://extensions or restart the browser.'
					: 'No live extension control watcher to serve the bind page. Reload the extension after `argus extension setup`.',
			code: 'not_available',
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
	/** True when the first attempt found an existing watcher; retained when that binding resumes. */
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

	let result: ExtensionBindResult | null = null
	try {
		result = await bindClaimedTicket(claim.ticket, claim.claimId, { ...options, visibility }, output)
		if (!result) return
	} catch (error) {
		emitFailure(output, { error: `Bind failed: ${formatError(error)}` })
		return
	} finally {
		if (!result) await releaseBindTicket(ticket, claim.claimId)
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
const bindClaimedTicket = async (ticket: BindTicket, claimId: string, options: BindInput, output: Output): Promise<ExtensionBindResult | null> => {
	const binding = ticket.checkpoint ?? (await attachTicketTab(ticket, options, output))
	if (!binding) return null
	if (options.as && options.as !== binding.watcher.id) {
		emitFailure(output, {
			error: `This ticket is already bound to ${binding.watcher.id}; retry with that id.`,
			code: 'invalid_request',
			exitCode: 2,
		})
		return null
	}
	const identityError = await verifyBindCheckpoint(binding, ticket.checkpoint ? undefined : ticket.ticket)
	if (identityError) {
		emitFailure(output, { error: identityError })
		return null
	}
	// Write-ahead checkpoint: even a lost navigation response or a crashed CLI can resume this tab.
	await checkpointBindTicket(ticket.ticket, claimId, binding)
	if (binding.navigatedUrl == null) {
		const navigated = await navigateTo(binding.watcher, ticket.destination)
		if (!navigated.ok) {
			emitFailure(output, { error: navigated })
			return null
		}
		binding.navigatedUrl = navigated.url
		await checkpointBindTicket(ticket.ticket, claimId, binding)
	}
	const visibilityIdentityError = await verifyBindCheckpoint(binding)
	if (visibilityIdentityError) {
		emitFailure(output, { error: visibilityIdentityError })
		return null
	}
	const visibility = await requestVisibility(binding.watcher, options.visibility ? { action: 'show', policy: options.visibility } : undefined)
	if (!visibility.ok) {
		emitFailure(output, { error: visibility })
		return null
	}
	const instanceId = binding.browserInstanceId
	if (options.label && !instanceId) {
		emitFailure(output, { error: `${binding.control.id}'s extension reports no browser instance id, so --label can't be recorded.`, exitCode: 2 })
		return null
	}
	if (options.label && instanceId) await setBrowserLabel(instanceId, options.label, 'bind')
	const label = instanceId ? ((await readBrowserLabels())[instanceId]?.label ?? null) : null
	const result: ExtensionBindResult = {
		ok: true,
		watcherId: binding.watcher.id,
		tabId: binding.tab.tabId,
		url: binding.navigatedUrl,
		control: { id: binding.control.id, pid: binding.control.pid },
		browser: { instanceId, label },
		attached: true,
		reused: binding.reused,
		targetReady: await waitForTargetReady(binding.watcher),
		visibility: visibility.state === 'shown' ? visibility.policy : 'default',
	}
	await completeBindTicket(ticket.ticket, claimId)
	return result
}

const attachTicketTab = async (ticket: BindTicket, options: BindInput, output: Output): Promise<BindCheckpoint | null> => {
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
	const identity = await verifyBindControl(control.watcher, instanceId)
	if (!identity.ok) {
		emitFailure(output, { error: identity })
		return null
	}
	const bound = await attachResolvedExtensionTabWatcher(control.watcher, tab, options, output)
	if (!bound) {
		return null
	}

	return {
		control: control.watcher,
		browserInstanceId: instanceId,
		tab: bound.tab,
		watcher: bound.watcher,
		reused,
	}
}

const navigateTo = async (watcher: WatcherRecord, url: string): Promise<ApiResult<NavigateResponse>> => {
	try {
		const identity = await readPinnedWatcherStatus(watcher)
		if (!identity.ok) return identity
		const response = await fetchWatcherJson<ApiResult<NavigateResponse>>(watcher, {
			path: '/navigate',
			method: 'POST',
			body: { url },
			timeoutMs: DEFAULT_NAVIGATION_TIMEOUT_MS + 5_000,
			returnErrorResponse: true,
		})
		return response
	} catch (error) {
		return { ok: false, error: { message: `${watcher.id}: failed to open ${url} (${formatError(error)})` } } satisfies ErrorResponse
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
		const status = await readPinnedWatcherStatus(watcher)
		if (status.ok) {
			last = status.targetReady ?? null
			if (last === true) {
				return last
			}
		} else if (status.error.code === 'registration_conflict') {
			return null
		}
		await delay(200)
	}
	return last
}
