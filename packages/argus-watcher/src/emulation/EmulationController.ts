import type { EmulationState, EmulationStatusResponse, EmulationSetResponse, EmulationClearResponse } from '@vforsh/argus-core'
import type { CdpSessionHandle } from '../cdp/connection.js'
import { applyEmulation, clearEmulation } from '../cdp/emulation.js'
import { evaluateInPage } from '../cdp/pageState.js'
import { createStickyController } from '../stickyController.js'

export type EmulationController = {
	getStatus: (ctx: { attached: boolean }) => EmulationStatusResponse
	setDesired: (state: EmulationState, session: CdpSessionHandle | null) => Promise<EmulationSetResponse>
	clearDesired: (session: CdpSessionHandle | null) => Promise<EmulationClearResponse>
	onAttach: (session: CdpSessionHandle) => Promise<void>
}

/**
 * Desired viewport/touch/user-agent emulation, re-applied on every attach until cleared.
 *
 * Unlike the other sticky controllers this carries a baseline: the pre-override user-agent
 * has to be sampled from a fresh session before anything is applied, so clearing can
 * restore it.
 */
export const createEmulationController = (): EmulationController => {
	let baselineUserAgent: string | null = null
	const getBaseline = () => ({ userAgent: baselineUserAgent })

	const sticky = createStickyController<EmulationState>({
		label: 'Emulation',
		apply: (session, state) => applyEmulation(session, state, getBaseline()),
		clear: (session) => clearEmulation(session, getBaseline()),
		onBeforeReapply: async (session) => {
			const value = await evaluateInPage<unknown>(session, 'navigator.userAgent').catch(() => null)
			baselineUserAgent = typeof value === 'string' ? value : null
		},
	})

	return {
		getStatus: (ctx) => {
			const { applied, state, lastError } = sticky.getState()
			return { ok: true, attached: ctx.attached, applied, state, baseline: getBaseline(), lastError }
		},
		setDesired: async (state, session) => {
			const { attached, applied, state: next, lastError } = await sticky.setDesired(state, session)
			return { ok: true, attached, applied, state: next, ...(lastError ? { error: lastError } : {}) }
		},
		clearDesired: async (session) => {
			const { attached, applied, lastError } = await sticky.clearDesired(session)
			return { ok: true, attached, applied, state: null, ...(lastError ? { error: lastError } : {}) }
		},
		onAttach: sticky.onAttach,
	}
}
