import { codedError } from '../errors.js'
import type { ExtensionSession } from '../native-messaging/session-manager.js'
import type { CdpTargetContext } from '../cdp/connection.js'
import {
	buildFrameTargetContext,
	createNotAttachedError,
	resolveSelectedFrameCommandState,
	type ExtensionFrameState,
} from './extension-frame-state.js'
import { delay } from '@vforsh/argus-core'

const TARGET_RECOVERY_INTERVAL_MS = 500
const TARGET_RECOVERY_TIMEOUT_MS = 30_000
const FRAME_COMMAND_READY_TIMEOUT_MS = 3_000
const FRAME_COMMAND_READY_POLL_MS = 100
/**
 * After a top-level reload the selected iframe has to be re-created by the host page and then boot
 * its own document; a command arriving inside this window waits for that instead of failing at 3s.
 * Agents used to bridge the gap with `sleep 25` and hand-rolled retry loops.
 */
const POST_NAVIGATION_READY_WINDOW_MS = 15_000

type TargetRecovery = { timer: ReturnType<typeof setInterval>; deadline: number }

type TargetRecoveryDeps = {
	getCurrentSession: () => ExtensionSession | null
	getOrCreateFrameState: (tabId: number) => ExtensionFrameState
	refreshFrameTree: (session: ExtensionSession) => Promise<void>
	reconcileTargetSelection: (session: ExtensionSession) => boolean
}

export type TargetRecoveryController = {
	/** Start or stop the per-tab recovery loop based on whether the selected frame is still pending. */
	sync: (session: ExtensionSession, state: ExtensionFrameState) => void
	clear: (tabId: number) => void
	clearAll: () => void
	/**
	 * Resolve the frame-scoped target context for the currently selected iframe,
	 * polling (and driving recovery) until the frame is executable or the
	 * readiness timeout elapses.
	 *
	 * `budgetMs` is the command's own deadline. The wait never takes more than half of it, so a short
	 * poll still gets the watcher's "missing"/"not ready" answer back. Shortly after a reload the wait
	 * stretches to the rest of `POST_NAVIGATION_READY_WINDOW_MS`; without a budget the caller's
	 * transport timeout is unknown, so it stays at the short default.
	 */
	waitForSelectedFrameCommandTarget: (budgetMs?: number) => Promise<Extract<CdpTargetContext, { kind: 'frame' }>>
}

/**
 * Selected-iframe recovery: after a reload the requested frame can temporarily
 * disappear or lack an execution context. This controller re-reads the frame
 * tree on an interval until the selection can be re-resolved, instead of
 * silently routing commands to the parent page.
 */
export const createTargetRecovery = (deps: TargetRecoveryDeps): TargetRecoveryController => {
	const { getCurrentSession, getOrCreateFrameState, refreshFrameTree, reconcileTargetSelection } = deps
	const recoveryByTabId = new Map<number, TargetRecovery>()

	const sync = (session: ExtensionSession, state: ExtensionFrameState): void => {
		if (!needsTargetRecovery(state)) {
			clear(session.tabId)
			return
		}

		if (recoveryByTabId.has(session.tabId)) {
			return
		}

		const timer = setInterval(() => {
			void retry(session.tabId)
		}, TARGET_RECOVERY_INTERVAL_MS)

		recoveryByTabId.set(session.tabId, {
			timer,
			deadline: Date.now() + TARGET_RECOVERY_TIMEOUT_MS,
		})
	}

	const clear = (tabId: number): void => {
		const recovery = recoveryByTabId.get(tabId)
		if (!recovery) {
			return
		}

		clearInterval(recovery.timer)
		recoveryByTabId.delete(tabId)
	}

	const clearAll = (): void => {
		for (const tabId of recoveryByTabId.keys()) {
			clear(tabId)
		}
	}

	const retry = async (tabId: number): Promise<void> => {
		const recovery = recoveryByTabId.get(tabId)
		const session = getCurrentSession()
		if (!recovery || !session || session.tabId !== tabId) {
			clear(tabId)
			return
		}

		if (Date.now() >= recovery.deadline) {
			clear(tabId)
			return
		}

		const state = getOrCreateFrameState(tabId)
		if (!needsTargetRecovery(state)) {
			clear(tabId)
			return
		}

		try {
			await refreshFrameTree(session)
		} catch {
			// Best-effort; Chrome can reject frame-tree reads transiently during reload.
		}

		reconcileTargetSelection(session)
		if (!needsTargetRecovery(getOrCreateFrameState(tabId))) {
			clear(tabId)
		}
	}

	/** Ensure the recovery loop is running and trigger an immediate retry. */
	const kick = async (session: ExtensionSession): Promise<void> => {
		const state = getOrCreateFrameState(session.tabId)
		if (!needsTargetRecovery(state)) {
			return
		}

		sync(session, state)
		await retry(session.tabId)
	}

	const waitForSelectedFrameCommandTarget = async (budgetMs?: number): Promise<Extract<CdpTargetContext, { kind: 'frame' }>> => {
		const session = getCurrentSession()
		if (!session) {
			throw createNotAttachedError()
		}
		const tabId = session.tabId
		const immediate = resolveSelectedFrameCommandState(getOrCreateFrameState(tabId))
		if (immediate.kind === 'frame') {
			return buildFrameTargetContext(getOrCreateFrameState(tabId), immediate.frameId)
		}

		// The deadline covers the first frame-tree refresh too: that pull has its own, longer timeout.
		const startedAt = Date.now()
		const deadline = startedAt + readinessTimeoutMs(getOrCreateFrameState(tabId), budgetMs)
		// `retry` swallows refresh failures; the catch only keeps a late rejection from going unhandled.
		await Promise.race([kick(session).catch(() => {}), delay(deadline - startedAt)])

		for (;;) {
			const current = getCurrentSession()
			if (!current || current.tabId !== tabId) {
				throw createNotAttachedError()
			}

			const commandState = resolveSelectedFrameCommandState(getOrCreateFrameState(tabId))
			if (commandState.kind === 'frame') {
				return buildFrameTargetContext(getOrCreateFrameState(tabId), commandState.frameId)
			}

			const remainingMs = deadline - Date.now()
			if (remainingMs <= 0) break
			await delay(Math.min(FRAME_COMMAND_READY_POLL_MS, remainingMs))
		}

		throw buildSelectedFrameUnavailableError(tabId, getOrCreateFrameState(tabId), Date.now() - startedAt)
	}

	return { sync, clear, clearAll, waitForSelectedFrameCommandTarget }
}

const needsTargetRecovery = (state: ExtensionFrameState): boolean => resolveSelectedFrameCommandState(state).kind === 'pending'

const readinessTimeoutMs = (state: ExtensionFrameState, budgetMs: number | undefined): number => {
	if (budgetMs == null) {
		return FRAME_COMMAND_READY_TIMEOUT_MS
	}
	const sinceNavigation = state.lastTopNavigationAt == null ? Infinity : Date.now() - state.lastTopNavigationAt
	const wanted =
		sinceNavigation < POST_NAVIGATION_READY_WINDOW_MS
			? Math.max(FRAME_COMMAND_READY_TIMEOUT_MS, POST_NAVIGATION_READY_WINDOW_MS - sinceNavigation)
			: FRAME_COMMAND_READY_TIMEOUT_MS
	// Half the budget at most: a frame that turns ready late still leaves the command time to run.
	return Math.min(wanted, budgetMs / 2)
}

/**
 * Two codes, because the fixes differ: a missing frame waits on the host page to re-create it (or
 * the selector no longer matches anything), a frame without an execution context is still booting.
 */
const buildSelectedFrameUnavailableError = (tabId: number, state: ExtensionFrameState, waitedMs: number): Error => {
	const waited = `waited ${(waitedMs / 1000).toFixed(1)}s`
	const commandState = resolveSelectedFrameCommandState(state)
	if (commandState.kind === 'pending' && commandState.reason === 'frame_missing') {
		return codedError(
			'extension_frame_missing',
			`Selected iframe on tab ${tabId} is missing (${waited} for ${describeRequestedFrame(state)}). It stays selected and commands never fall back to the host page; retry once the page re-creates it, or pick another target with argus ext select.`,
		)
	}
	return codedError(
		'extension_frame_not_ready',
		`Selected iframe on tab ${tabId} has no execution context yet (${waited}); its document is still loading. Retry in a few seconds, or reattach the watcher if it persists.`,
	)
}

const describeRequestedFrame = (state: ExtensionFrameState): string => {
	const hint = state.requestedFrameHint
	if (hint?.match) return `a frame whose ${hint.match.by} contains "${hint.match.value}"`
	if (hint?.urlKey) return `a frame at ${hint.urlKey}`
	return `frame ${state.requestedFrameId}`
}

