import { HttpResponseError, type NetActivityResponse, type WatcherRecord } from '@vforsh/argus-core'
import type { Output } from '../output/io.js'
import { getRequestContext } from '../session/requestContext.js'
import { fetchWatcherJson } from '../watchers/requestWatcher.js'
import { formatSeconds, waitForCondition } from './conditionWait.js'
import { parseDurationFlagMs } from './evalShared.js'

/**
 * `--settle`: wait until the page stops moving, instead of `sleep N`.
 *
 * Agents slept after 137 of a week's goto/reload/click calls (377 shell sleeps in all) because
 * they had no generic "done" signal. Settle is that signal, in three phases:
 *
 *  1. the document is `complete` (never the one a navigation left: the pre-navigation guard),
 *  2. the network is quiet — no open request for {@link QUIET_MS}, counted from the action at the
 *     earliest so a request the click starts a moment later is not missed,
 *  3. the app agrees — an optional `window.__argus.settle()` hook (return `false` for "not yet"),
 *     then two animation frames so the last state change is painted.
 *
 * Settling is best effort: a page that never goes quiet (polling, streaming) reports
 * `settled: false` and the command still succeeds. Use `--until` to assert a state.
 */

export type SettleFlags = {
	settle?: boolean
	settleTimeout?: string
}

export type SettlePlan = { timeoutMs: number }

export type SettleOutcome = {
	settled: boolean
	elapsedMs: number
	/**
	 * `unsupported`: the watcher predates `GET /net/activity` or has net capture off (settling skips
	 * the phase). `unknown`: the probe kept failing, so quiet was never confirmed (not settled).
	 */
	network: 'quiet' | 'busy' | 'unsupported' | 'unknown'
	/** Open requests at the deadline, when the network never went quiet. */
	pending?: number
	page: 'ready' | 'loading' | 'busy'
}

const DEFAULT_SETTLE_TIMEOUT_MS = 10_000
const QUIET_MS = 500
const NETWORK_POLL_MS = 100

/**
 * Resolve `--settle` / `--no-settle` / `--settle-timeout`.
 *
 * @param defaultOn Whether to settle when neither `--settle` nor `--no-settle` was given.
 * @returns `undefined` when not settling, `null` after a usage error.
 */
export const parseSettleFlags = (options: SettleFlags, output: Output, defaultOn: boolean): SettlePlan | undefined | null => {
	const timeout = parseDurationFlagMs(options.settleTimeout, '--settle-timeout')
	if (timeout.error) {
		output.writeWarn(timeout.error)
		process.exitCode = 2
		return null
	}
	if (!(options.settle ?? defaultOn)) return undefined
	return { timeoutMs: timeout.value ?? DEFAULT_SETTLE_TIMEOUT_MS }
}

/** Page-side check for phase 3: the app's own idle hook, then two painted frames. */
const SETTLE_HOOK_EXPRESSION = `(async () => {
	const hook = globalThis.__argus && globalThis.__argus.settle
	if (typeof hook === 'function' && (await hook()) === false) return false
	await new Promise((resolve) => {
		let frames = 0
		const tick = () => (++frames >= 2 ? resolve() : requestAnimationFrame(tick))
		requestAnimationFrame(tick)
		setTimeout(resolve, 250) // background tabs throttle rAF
	})
	return true
})()`

/**
 * Wait for the page to settle after an action.
 *
 * @param actionEndedAt When the action returned; network quiet is measured from no earlier than this.
 * @param navigatedFrom The pre-action document of a navigating action (see `waitForCondition`).
 */
export const settlePage = async (
	watcher: Pick<WatcherRecord, 'id' | 'host' | 'port'>,
	plan: SettlePlan,
	actionEndedAt: number,
	navigatedFrom?: string,
): Promise<SettleOutcome> => {
	const startedAt = Date.now()
	const deadline = startedAt + plan.timeoutMs
	const remaining = (): number => deadline - Date.now()
	const finish = (fields: Omit<SettleOutcome, 'elapsedMs' | 'settled'>): SettleOutcome => ({
		settled: fields.page === 'ready' && networkSettled(fields.network),
		elapsedMs: Date.now() - startedAt,
		...fields,
	})

	// `--settle-timeout` bounds all three phases together: each gets only what the previous left.
	const loaded = await waitForCondition(watcher, { expression: "document.readyState === 'complete'", timeoutMs: remaining() }, navigatedFrom)
	if (!loaded.matched) return finish({ network: 'unknown', page: 'loading' })

	const network = await waitForNetworkQuiet(watcher, deadline, actionEndedAt)
	if (!networkSettled(network.network) || remaining() <= 0) return finish({ ...network, page: 'busy' })

	const hook = await waitForCondition(watcher, { expression: SETTLE_HOOK_EXPRESSION, timeoutMs: remaining() })
	return finish({ ...network, page: hook.matched ? 'ready' : 'busy' })
}

const waitForNetworkQuiet = async (
	watcher: Pick<WatcherRecord, 'host' | 'port'>,
	deadline: number,
	actionEndedAt: number,
): Promise<Pick<SettleOutcome, 'network' | 'pending'>> => {
	const { signal } = getRequestContext()
	let pending: number | undefined
	while (Date.now() < deadline && !signal?.aborted) {
		let activity: NetActivityResponse
		try {
			activity = await fetchWatcherJson<NetActivityResponse>(watcher, { path: '/net/activity', timeoutMs: Math.min(1_500, deadline - Date.now()), deadline })
		} catch (error) {
			// Only a watcher that cannot answer this question skips the phase; a failing probe is not quiet.
			if (isUnsupported(error)) return { network: 'unsupported' }
			await pause(NETWORK_POLL_MS)
			continue
		}
		pending = activity.pending
		// Measured on the watcher's clock; the action's end is ours, so compare that one locally.
		const sinceTraffic = activity.lastActivityAt == null ? Infinity : activity.now - activity.lastActivityAt
		if (pending === 0 && sinceTraffic >= QUIET_MS && Date.now() - actionEndedAt >= QUIET_MS) return { network: 'quiet' }
		await pause(NETWORK_POLL_MS)
	}
	return pending === undefined ? { network: 'unknown' } : { network: 'busy', pending }
}

/** A watcher that cannot report traffic is no reason to wait; one that reported traffic must have gone quiet. */
const networkSettled = (network: SettleOutcome['network']): boolean => network === 'quiet' || network === 'unsupported'

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 404: a watcher from before `GET /net/activity`; `net_disabled`: one started without net capture. */
const isUnsupported = (error: unknown): boolean =>
	error instanceof HttpResponseError && (error.status === 404 || error.code === 'net_disabled')

/** Human note for a settle that ran out. */
export const describeSettleMiss = (plan: SettlePlan, outcome: SettleOutcome): string =>
	`settle: ${describeStuckPhase(outcome)} after ${formatSeconds(plan.timeoutMs)}`

const describeStuckPhase = (outcome: SettleOutcome): string => {
	if (outcome.page === 'loading') return 'document still loading'
	if (outcome.network === 'busy') return outcome.pending ? `network still busy (${outcome.pending} open requests)` : `network not quiet for ${QUIET_MS}ms yet`
	if (outcome.network === 'unknown') return 'network state unknown (activity probe kept failing)'
	return 'page hook or frames never settled'
}
