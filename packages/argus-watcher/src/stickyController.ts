import type { ErrorDetail } from '@vforsh/argus-core'
import type { CdpSessionHandle } from './cdp/connection.js'

/**
 * The "desired state survives detach" machine, written once.
 *
 * Emulation, throttle, and visibility each implemented it separately — closure state for
 * `desired`/`applied`/`lastError`, set-then-apply-if-attached, clear-then-same, and an
 * `onAttach` that re-applies and warns. They had already drifted: Visibility threw from
 * `setLock` instead of returning an error, and Emulation carries a baseline the others
 * do not. The pattern clearly accretes, so the next one gets it for free.
 */

/** Snapshot of a sticky controller's state. */
export type StickyState<TState> = {
	/** Whether the desired state is currently live on a CDP session. */
	applied: boolean
	/** Desired state, or `null` when cleared. */
	state: TState | null
	/** Why the last apply failed, if it did. */
	lastError: ErrorDetail | null
}

/** Outcome of a set or clear, including whether a session was attached to apply it to. */
export type StickyResult<TState> = StickyState<TState> & { attached: boolean }

export type StickyControllerOptions<TState> = {
	/** Label used in the re-apply warning. */
	label: string
	/** Push the desired state onto a session. */
	apply: (session: CdpSessionHandle, state: TState) => Promise<void>
	/** Undo the state on a session. */
	clear: (session: CdpSessionHandle) => Promise<void>
	/**
	 * Runs on every attach before re-applying, for state that must be sampled from a
	 * fresh session (emulation captures the baseline user-agent this way).
	 */
	onBeforeReapply?: (session: CdpSessionHandle) => Promise<void>
}

/** A controller whose desired state is re-applied on every attach. */
export type StickyController<TState> = {
	/** Read the current state without touching a session. */
	getState: () => StickyState<TState>
	/** Set the desired state and apply it now when a session is attached. */
	setDesired: (state: TState, session: CdpSessionHandle | null) => Promise<StickyResult<TState>>
	/** Clear the desired state and undo it now when a session is attached. */
	clearDesired: (session: CdpSessionHandle | null) => Promise<StickyResult<TState>>
	/** Re-apply the desired state to a freshly attached session. */
	onAttach: (session: CdpSessionHandle) => Promise<void>
}

/** Build a {@link StickyController}. */
export const createStickyController = <TState>(options: StickyControllerOptions<TState>): StickyController<TState> => {
	let desired: TState | null = null
	let applied = false
	let lastError: ErrorDetail | null = null

	const getState = (): StickyState<TState> => ({ applied, state: desired, lastError })

	/** Run one CDP mutation, recording success or failure in the shared state. */
	const run = async (session: CdpSessionHandle, action: () => Promise<void>, appliedOnSuccess: boolean): Promise<StickyResult<TState>> => {
		try {
			await action()
			applied = appliedOnSuccess
			lastError = null
			return { attached: true, applied: true, state: desired, lastError: null }
		} catch (error) {
			applied = false
			lastError = { message: error instanceof Error ? error.message : String(error) }
			return { attached: true, applied: false, state: desired, lastError }
		}
	}

	const detached = (): StickyResult<TState> => {
		applied = false
		return { attached: false, applied: false, state: desired, lastError }
	}

	return {
		getState,

		setDesired: async (state, session) => {
			desired = state
			lastError = null
			if (!session?.isAttached()) {
				return detached()
			}
			return await run(session, () => options.apply(session, state), true)
		},

		clearDesired: async (session) => {
			desired = null
			lastError = null
			if (!session?.isAttached()) {
				return detached()
			}
			// A successful clear leaves nothing applied, which is why `applied` goes false.
			return await run(session, () => options.clear(session), false)
		},

		onAttach: async (session) => {
			await options.onBeforeReapply?.(session)

			if (!desired) {
				applied = false
				return
			}

			try {
				await options.apply(session, desired)
				applied = true
				lastError = null
			} catch (error) {
				applied = false
				lastError = { message: error instanceof Error ? error.message : String(error) }
				console.warn(`[${options.label}] Failed to re-apply on attach: ${lastError.message}`)
			}
		},
	}
}
