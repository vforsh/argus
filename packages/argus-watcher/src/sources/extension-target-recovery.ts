import type { ExtensionSession } from '../native-messaging/session-manager.js'
import type { CdpTargetContext } from '../cdp/connection.js'
import {
	buildFrameTargetContext,
	createNotAttachedError,
	resolveSelectedFrameCommandState,
	type ExtensionFrameState,
} from './extension-frame-state.js'

const TARGET_RECOVERY_INTERVAL_MS = 500
const TARGET_RECOVERY_TIMEOUT_MS = 30_000
const FRAME_COMMAND_READY_TIMEOUT_MS = 3_000
const FRAME_COMMAND_READY_POLL_MS = 100

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
	 */
	waitForSelectedFrameCommandTarget: () => Promise<Extract<CdpTargetContext, { kind: 'frame' }>>
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

	const waitForSelectedFrameCommandTarget = async (): Promise<Extract<CdpTargetContext, { kind: 'frame' }>> => {
		const session = getCurrentSession()
		if (!session) {
			throw createNotAttachedError()
		}
		const tabId = session.tabId
		const immediate = resolveSelectedFrameCommandState(getOrCreateFrameState(tabId))
		if (immediate.kind === 'frame') {
			return buildFrameTargetContext(getOrCreateFrameState(tabId), immediate.frameId)
		}

		await kick(session)

		const deadline = Date.now() + FRAME_COMMAND_READY_TIMEOUT_MS
		while (Date.now() < deadline) {
			await delay(FRAME_COMMAND_READY_POLL_MS)

			const current = getCurrentSession()
			if (!current || current.tabId !== tabId) {
				throw createNotAttachedError()
			}

			const commandState = resolveSelectedFrameCommandState(getOrCreateFrameState(tabId))
			if (commandState.kind === 'frame') {
				return buildFrameTargetContext(getOrCreateFrameState(tabId), commandState.frameId)
			}
		}

		throw buildSelectedFrameNotReadyError(tabId)
	}

	return { sync, clear, clearAll, waitForSelectedFrameCommandTarget }
}

const needsTargetRecovery = (state: ExtensionFrameState): boolean => resolveSelectedFrameCommandState(state).kind === 'pending'

const buildSelectedFrameNotReadyError = (tabId: number): Error => {
	const error = new Error(
		`Selected iframe target on tab ${tabId} is not executable yet after reload. Try again in a few seconds or reattach the watcher if the problem persists.`,
	)
	;(error as Error & { code?: string }).code = 'extension_frame_not_ready'
	return error
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
