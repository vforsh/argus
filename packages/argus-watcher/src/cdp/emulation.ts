import type { EmulationState } from '@vforsh/argus-core'
import type { CdpSessionHandle } from './connection.js'

type Baseline = { userAgent: string | null }

/**
 * Apply the desired emulation state to a CDP session.
 * Each aspect (viewport, touch, UA) is applied independently so partial failures don't block the rest.
 */
export const applyEmulation = async (session: CdpSessionHandle, state: EmulationState, baseline: Baseline): Promise<void> => {
	// Viewport / device metrics
	if (state.viewport) {
		await session.sendAndWait('Emulation.setDeviceMetricsOverride', {
			width: state.viewport.width,
			height: state.viewport.height,
			deviceScaleFactor: state.viewport.deviceScaleFactor,
			mobile: state.viewport.mobile,
		})
	} else {
		await session.sendAndWait('Emulation.clearDeviceMetricsOverride')
	}

	// Touch emulation
	const touchEnabled = state.touch?.enabled ?? false
	await session.sendAndWait('Emulation.setTouchEmulationEnabled', { enabled: touchEnabled })

	// User-agent override
	if (state.userAgent?.value != null) {
		await session.sendAndWait('Emulation.setUserAgentOverride', { userAgent: state.userAgent.value })
	} else if (baseline.userAgent) {
		// Restore baseline UA (no "clear UA override" primitive exists)
		await session.sendAndWait('Emulation.setUserAgentOverride', { userAgent: baseline.userAgent })
	}
}

/**
 * Clear all emulation overrides, restoring the page to its default state.
 */
export const clearEmulation = async (session: CdpSessionHandle, baseline: Baseline): Promise<void> => {
	await session.sendAndWait('Emulation.clearDeviceMetricsOverride')
	await session.sendAndWait('Emulation.setTouchEmulationEnabled', { enabled: false })

	if (baseline.userAgent) {
		await session.sendAndWait('Emulation.setUserAgentOverride', { userAgent: baseline.userAgent })
	}
}
