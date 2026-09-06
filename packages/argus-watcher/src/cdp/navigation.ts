import {
	DEFAULT_INTERACTION_NAV_TIMEOUT_MS,
	type LogEpoch,
	type NavigationDirection,
	type NavigationSummary,
	type NavigationWait,
	type NavigationWaitOptions,
} from '@vforsh/argus-core'
import type { CdpSessionHandle } from './connection.js'
import { codedError, hasErrorCode } from '../errors.js'

/**
 * Waiting for a navigation to finish, for every command that causes one.
 *
 * The hard part is not sending `Page.navigate` — it is knowing when the answer is safe to
 * send back. A load event on its own proves nothing: it may belong to the document that was
 * already there when the command was issued. So a wait only counts a `domContentEventFired`
 * or `loadEventFired` that arrives *after* the top-frame `Page.frameNavigated`, and — when
 * Chrome told us which loader it started — for that loader.
 *
 * Handlers are attached before the navigating command is sent, never after, so a fast
 * same-origin load cannot slip through the gap between the send and the subscribe.
 */

/** A primed navigation wait. Always `dispose()` it, including on the failure path. */
export type NavigationWaiter = {
	/**
	 * Wait for the requested phase, resolving to the URL navigated to, or `null` when nothing
	 * navigated (which is what `wait: 'none'` always reports).
	 *
	 * @param expectedLoaderId Loader id from the navigating command, when it reported one. A load
	 *   event for a different loader (a redirect chain's earlier hop, a concurrent reload) is ignored.
	 * @throws A `navigation_timeout` coded error when the phase does not arrive in time.
	 */
	settle: (expectedLoaderId?: string | null) => Promise<string | null>
	dispose: () => void
}

/** Subscribe to the navigation lifecycle before issuing the command that triggers it. */
export const armNavigationWaiter = (session: CdpSessionHandle, options: { wait: NavigationWait; timeoutMs: number }): NavigationWaiter => {
	let topFrameId: string | null = null
	let navigatedUrl: string | null = null
	let navigatedLoaderId: string | null = null
	let domFired = false
	let loadFired = false
	// Set when the navigation completed but no dom/load event will ever follow it: a hash change
	// or pushState (same document), and a back/forward-cache restore (the document is resumed,
	// not parsed). Waiting for `load` in either case would burn the whole timeout on a page that
	// is already there.
	let settledWithoutLoadUrl: string | null = null
	let notify: (() => void) | null = null

	// The top frame's id, so a same-document navigation inside an iframe cannot settle the wait.
	// Fire-and-forget: a detached session fails the navigating command with its own error.
	void session
		.sendAndWait('Page.getFrameTree')
		.then((result) => {
			topFrameId = result.frameTree?.frame.id ?? null
		})
		.catch(() => {})

	const isSettled = (expectedLoaderId: string | null): boolean => {
		if (settledWithoutLoadUrl != null) return true
		if (navigatedUrl == null) return false
		if (expectedLoaderId != null && navigatedLoaderId != null && navigatedLoaderId !== expectedLoaderId) return false
		return options.wait === 'domcontentloaded' ? domFired || loadFired : loadFired
	}

	const removers = [
		// A child target's events carry a sessionId; only the top frame's do not.
		session.onEvent('Page.frameNavigated', (params, meta) => {
			const frame = params.frame
			if (meta.sessionId || !frame || frame.parentId) return
			topFrameId = frame.id
			navigatedUrl = frame.url ?? ''
			navigatedLoaderId = frame.loaderId ?? null
			domFired = false
			loadFired = false
			settledWithoutLoadUrl = params.type === 'BackForwardCacheRestore' ? navigatedUrl : null
			notify?.()
		}),
		session.onEvent('Page.domContentEventFired', (_params, meta) => {
			if (meta.sessionId) return
			domFired = true
			notify?.()
		}),
		session.onEvent('Page.loadEventFired', (_params, meta) => {
			if (meta.sessionId) return
			loadFired = true
			notify?.()
		}),
		session.onEvent('Page.navigatedWithinDocument', (params, meta) => {
			if (meta.sessionId || !params.url) return
			if (topFrameId != null && params.frameId !== topFrameId) return
			settledWithoutLoadUrl = params.url
			notify?.()
		}),
	]

	let timer: NodeJS.Timeout | null = null
	const dispose = (): void => {
		for (const remove of removers) remove()
		if (timer) clearTimeout(timer)
		timer = null
		notify = null
	}

	const settle = async (expectedLoaderId: string | null = null): Promise<string | null> => {
		if (options.wait === 'none') {
			return null
		}

		if (!isSettled(expectedLoaderId)) {
			await new Promise<void>((resolve, reject) => {
				notify = () => {
					if (!isSettled(expectedLoaderId)) return
					notify = null
					resolve()
				}
				timer = setTimeout(() => {
					notify = null
					reject(codedError('navigation_timeout', `Navigation did not reach "${options.wait}" within ${options.timeoutMs}ms.`))
				}, options.timeoutMs)
			})
		}

		return settledWithoutLoadUrl ?? navigatedUrl
	}

	return { settle, dispose }
}

/** Result of a completed `Page.navigate`. */
export type NavigatePageResult = { url: string; loaderId: string | null }

/**
 * Navigate the page and wait for the requested phase.
 *
 * @throws A `navigation_failed` coded error when Chrome refuses the URL (bad host, blocked
 *   scheme); `navigation_timeout` when the load does not complete in time. Both are the
 *   request's fault or the network's, so they are reported as such rather than as CDP errors.
 */
export const navigatePage = async (
	session: CdpSessionHandle,
	options: { url: string; wait: NavigationWait; timeoutMs: number },
): Promise<NavigatePageResult> => {
	const waiter = armNavigationWaiter(session, options)
	try {
		const result = await session.sendAndWait('Page.navigate', { url: options.url })
		if (result.errorText) {
			throw codedError('navigation_failed', `Navigation to ${options.url} failed: ${result.errorText}`)
		}

		const loaderId = result.loaderId ?? null
		const settledUrl = await waiter.settle(loaderId)
		return { url: settledUrl ?? options.url, loaderId }
	} finally {
		waiter.dispose()
	}
}

/** Result of a completed history navigation. */
export type NavigateHistoryResult = { url: string; index: number; length: number }

/**
 * Move through the session history and wait for the requested phase.
 *
 * @throws A `no_history` coded error when the requested step falls outside the history, which
 *   is what "already at the first entry" looks like — not a transport failure.
 */
export const navigateHistory = async (
	session: CdpSessionHandle,
	options: { direction: NavigationDirection; steps: number; wait: NavigationWait; timeoutMs: number },
): Promise<NavigateHistoryResult> => {
	const history = await session.sendAndWait('Page.getNavigationHistory')
	const entries = history.entries ?? []
	const currentIndex = history.currentIndex ?? 0

	const targetIndex = currentIndex + (options.direction === 'back' ? -options.steps : options.steps)
	const entry = entries[targetIndex]
	if (!entry) {
		const step = options.steps === 1 ? '' : ` ${options.steps} entries`
		throw codedError(
			'no_history',
			`Cannot go ${options.direction}${step}: at entry ${currentIndex + 1} of ${entries.length} in the session history.`,
		)
	}

	const waiter = armNavigationWaiter(session, options)
	try {
		await session.sendAndWait('Page.navigateToHistoryEntry', { entryId: entry.id })
		const settledUrl = await waiter.settle()
		return { url: settledUrl ?? entry.url, index: targetIndex, length: entries.length }
	} finally {
		waiter.dispose()
	}
}

/**
 * Run an interaction that may navigate, and report whether it did.
 *
 * A click on a plain button navigates nowhere, and that is the common case — so a timeout here
 * is a `navigated: false` summary, not an error. Only a **top-frame** navigation counts: an
 * iframe that navigates internally reports `navigated: false`.
 *
 * @param beginEpoch Opens a log epoch just before the interaction, so the caller can read the
 *   new page's console output without racing it. Only called when a wait was requested.
 */
export const withNavigationWait = async <T>(
	session: CdpSessionHandle,
	options: NavigationWaitOptions,
	beginEpoch: () => LogEpoch,
	act: () => Promise<T>,
): Promise<{ result: T; navigation?: NavigationSummary }> => {
	if (!options.waitNav) {
		return { result: await act() }
	}

	const epoch = beginEpoch()
	const waiter = armNavigationWaiter(session, {
		wait: options.waitNav,
		timeoutMs: options.navTimeoutMs ?? DEFAULT_INTERACTION_NAV_TIMEOUT_MS,
	})

	try {
		const result = await act()
		return { result, navigation: await summarizeNavigation(waiter, epoch) }
	} finally {
		waiter.dispose()
	}
}

/** Settle a `--wait-nav` waiter, turning its timeout into a "nothing navigated" summary. */
const summarizeNavigation = async (waiter: NavigationWaiter, epoch: LogEpoch): Promise<NavigationSummary> => {
	try {
		const url = await waiter.settle()
		return { navigated: url != null, url, epoch }
	} catch (error) {
		if (!hasErrorCode(error, 'navigation_timeout')) throw error
		return { navigated: false, url: null, epoch }
	}
}
