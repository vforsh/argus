import type { EmulationRequest, EmulationState } from '@vforsh/argus-core'
import { defineJsonRoute } from './defineRoute.js'

const validActions = ['set', 'clear'] as const

export const route = defineJsonRoute<EmulationRequest>({
	method: 'POST',
	path: '/emulation',
	parseBody: true,
	endpoint: 'emulation',
	validate: validateEmulationRequest,
	handle: async ({ ctx, body: payload }) => {
		const session = ctx.cdpSession.isAttached() ? ctx.cdpSession : null

		if (payload.action === 'clear') {
			return ctx.emulationController.clearDesired(session)
		}

		const state = (payload as { state: unknown }).state as EmulationState
		return ctx.emulationController.setDesired(state, session)
	},
})

function validateEmulationRequest(payload: EmulationRequest): string | null {
	const action = (payload as { action?: string }).action
	if (!action || !validActions.includes(action as (typeof validActions)[number])) {
		return `action must be one of: ${validActions.join(', ')}`
	}

	if (action === 'clear') {
		return null
	}

	const setPayload = payload as { action: 'set'; state?: unknown }
	if (!setPayload.state || typeof setPayload.state !== 'object') {
		return 'state is required for set action'
	}

	const state = setPayload.state as Record<string, unknown>

	if (state.viewport != null) {
		const vp = state.viewport as Record<string, unknown>
		if (!Number.isInteger(vp.width) || (vp.width as number) <= 0) {
			return 'viewport.width must be a positive integer'
		}
		if (!Number.isInteger(vp.height) || (vp.height as number) <= 0) {
			return 'viewport.height must be a positive integer'
		}
		if (typeof vp.deviceScaleFactor !== 'number' || !Number.isFinite(vp.deviceScaleFactor) || (vp.deviceScaleFactor as number) <= 0) {
			return 'viewport.deviceScaleFactor must be a finite number > 0'
		}
		if (typeof vp.mobile !== 'boolean') {
			return 'viewport.mobile must be a boolean'
		}
	}

	if (state.touch != null) {
		const touch = state.touch as Record<string, unknown>
		if (typeof touch.enabled !== 'boolean') {
			return 'touch.enabled must be a boolean'
		}
	}

	if (state.userAgent != null) {
		const ua = state.userAgent as Record<string, unknown>
		if (ua.value !== null && (typeof ua.value !== 'string' || ua.value === '')) {
			return 'userAgent.value must be a non-empty string or null'
		}
	}

	return null
}
