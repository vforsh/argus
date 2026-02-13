import type { CdpSessionHandle } from './connection.js'

/** Apply CPU throttle rate to a CDP session. */
export const applyThrottle = async (session: CdpSessionHandle, rate: number): Promise<void> => {
	await session.sendAndWait('Emulation.setCPUThrottlingRate', { rate })
}

/** Clear CPU throttle (reset to rate 1). */
export const clearThrottle = async (session: CdpSessionHandle): Promise<void> => {
	await session.sendAndWait('Emulation.setCPUThrottlingRate', { rate: 1 })
}
