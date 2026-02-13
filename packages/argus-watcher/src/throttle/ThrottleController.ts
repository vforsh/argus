import type { ThrottleState, ThrottleStatusResponse, ThrottleSetResponse, ThrottleClearResponse } from '@vforsh/argus-core'
import type { CdpSessionHandle } from '../cdp/connection.js'
import { applyThrottle, clearThrottle } from '../cdp/throttle.js'

type ThrottleError = { message: string; code?: string }

export type ThrottleController = {
	getStatus: (ctx: { attached: boolean }) => ThrottleStatusResponse
	setDesired: (rate: number, session: CdpSessionHandle | null) => Promise<ThrottleSetResponse>
	clearDesired: (session: CdpSessionHandle | null) => Promise<ThrottleClearResponse>
	onAttach: (session: CdpSessionHandle) => Promise<void>
}

export const createThrottleController = (): ThrottleController => {
	let desired: ThrottleState | null = null
	let applied = false
	let lastError: ThrottleError | null = null

	const getStatus = (ctx: { attached: boolean }): ThrottleStatusResponse => ({
		ok: true,
		attached: ctx.attached,
		applied,
		state: desired,
		lastError,
	})

	const setDesired = async (rate: number, session: CdpSessionHandle | null): Promise<ThrottleSetResponse> => {
		desired = { rate }
		lastError = null

		if (!session || !session.isAttached()) {
			applied = false
			return { ok: true, attached: false, applied: false, state: desired }
		}

		try {
			await applyThrottle(session, rate)
			applied = true
			return { ok: true, attached: true, applied: true, state: desired }
		} catch (error) {
			applied = false
			lastError = { message: error instanceof Error ? error.message : String(error) }
			return { ok: true, attached: true, applied: false, state: desired, error: lastError }
		}
	}

	const clearDesired = async (session: CdpSessionHandle | null): Promise<ThrottleClearResponse> => {
		desired = null
		lastError = null

		if (!session || !session.isAttached()) {
			applied = false
			return { ok: true, attached: false, applied: false, state: null }
		}

		try {
			await clearThrottle(session)
			applied = false
			return { ok: true, attached: true, applied: true, state: null }
		} catch (error) {
			applied = false
			lastError = { message: error instanceof Error ? error.message : String(error) }
			return { ok: true, attached: true, applied: false, state: null, error: lastError }
		}
	}

	const onAttach = async (session: CdpSessionHandle): Promise<void> => {
		if (!desired) {
			applied = false
			return
		}

		try {
			await applyThrottle(session, desired.rate)
			applied = true
			lastError = null
		} catch (error) {
			applied = false
			lastError = { message: error instanceof Error ? error.message : String(error) }
			console.warn(`[Throttle] Failed to re-apply throttle on attach: ${lastError.message}`)
		}
	}

	return { getStatus, setDesired, clearDesired, onAttach }
}
