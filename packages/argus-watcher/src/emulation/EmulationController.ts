import type { EmulationState, EmulationStatusResponse, EmulationSetResponse, EmulationClearResponse } from '@vforsh/argus-core'
import type { CdpSessionHandle } from '../cdp/connection.js'
import { applyEmulation, clearEmulation } from '../cdp/emulation.js'

type EmulationError = { message: string; code?: string }

export type EmulationController = {
	getStatus: (ctx: { attached: boolean }) => EmulationStatusResponse
	setDesired: (state: EmulationState, session: CdpSessionHandle | null) => Promise<EmulationSetResponse>
	clearDesired: (session: CdpSessionHandle | null) => Promise<EmulationClearResponse>
	onAttach: (session: CdpSessionHandle) => Promise<void>
}

export const createEmulationController = (): EmulationController => {
	let desired: EmulationState | null = null
	let applied = false
	let baselineUserAgent: string | null = null
	let lastError: EmulationError | null = null

	const getBaseline = () => ({ userAgent: baselineUserAgent })

	const getStatus = (ctx: { attached: boolean }): EmulationStatusResponse => ({
		ok: true,
		attached: ctx.attached,
		applied,
		state: desired,
		baseline: { userAgent: baselineUserAgent },
		lastError,
	})

	const setDesired = async (state: EmulationState, session: CdpSessionHandle | null): Promise<EmulationSetResponse> => {
		desired = state
		lastError = null

		if (!session || !session.isAttached()) {
			applied = false
			return { ok: true, attached: false, applied: false, state: desired }
		}

		try {
			await applyEmulation(session, state, getBaseline())
			applied = true
			return { ok: true, attached: true, applied: true, state: desired }
		} catch (error) {
			applied = false
			lastError = { message: error instanceof Error ? error.message : String(error) }
			return { ok: true, attached: true, applied: false, state: desired, error: lastError }
		}
	}

	const clearDesired = async (session: CdpSessionHandle | null): Promise<EmulationClearResponse> => {
		desired = null
		lastError = null

		if (!session || !session.isAttached()) {
			applied = false
			return { ok: true, attached: false, applied: false, state: null }
		}

		try {
			await clearEmulation(session, getBaseline())
			applied = false
			return { ok: true, attached: true, applied: true, state: null }
		} catch (error) {
			applied = false
			lastError = { message: error instanceof Error ? error.message : String(error) }
			return { ok: true, attached: true, applied: false, state: null, error: lastError }
		}
	}

	const onAttach = async (session: CdpSessionHandle): Promise<void> => {
		// Capture baseline UA before any overrides
		try {
			const result = (await session.sendAndWait('Runtime.evaluate', {
				expression: 'navigator.userAgent',
				returnByValue: true,
			})) as { result?: { value?: unknown } }
			const value = result?.result?.value
			baselineUserAgent = typeof value === 'string' ? value : null
		} catch {
			baselineUserAgent = null
		}

		// Re-apply desired state if set (persist-until-clear semantics)
		if (!desired) {
			applied = false
			return
		}

		try {
			await applyEmulation(session, desired, getBaseline())
			applied = true
			lastError = null
		} catch (error) {
			applied = false
			lastError = { message: error instanceof Error ? error.message : String(error) }
			console.warn(`[Emulation] Failed to re-apply emulation on attach: ${lastError.message}`)
		}
	}

	return { getStatus, setDesired, clearDesired, onAttach }
}
