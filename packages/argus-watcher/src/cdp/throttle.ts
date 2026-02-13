import type { ThrottleState } from '@vforsh/argus-core'
import type { CdpSessionHandle } from './connection.js'

/**
 * Apply the desired throttle state to a CDP session.
 * Each aspect (CPU, network, cache) is applied independently so partial failures don't block the rest.
 */
export const applyThrottle = async (session: CdpSessionHandle, state: ThrottleState): Promise<void> => {
	if (state.cpu) {
		await session.sendAndWait('Emulation.setCPUThrottlingRate', { rate: state.cpu.rate })
	}

	if (state.network) {
		await session.sendAndWait('Network.emulateNetworkConditions', {
			offline: state.network.offline,
			latency: state.network.latency,
			downloadThroughput: state.network.downloadThroughput,
			uploadThroughput: state.network.uploadThroughput,
		})
	}

	if (state.cache) {
		await session.sendAndWait('Network.setCacheDisabled', { cacheDisabled: state.cache.disabled })
	}
}

/**
 * Clear all throttle overrides, restoring defaults.
 */
export const clearThrottle = async (session: CdpSessionHandle): Promise<void> => {
	await session.sendAndWait('Emulation.setCPUThrottlingRate', { rate: 1 })
	await session.sendAndWait('Network.emulateNetworkConditions', {
		offline: false,
		latency: 0,
		downloadThroughput: -1,
		uploadThroughput: -1,
	})
	await session.sendAndWait('Network.setCacheDisabled', { cacheDisabled: false })
}
