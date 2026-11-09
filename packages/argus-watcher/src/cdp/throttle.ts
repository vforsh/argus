import type { NetworkThrottleState } from '@vforsh/argus-core'
import type { CdpSessionHandle } from './connection.js'

/** CDP throughput is bytes per second; the protocol speaks kilobits per second. */
const BYTES_PER_SECOND_PER_KBPS = 125

/** CDP's "no cap" throughput. */
const UNLIMITED_THROUGHPUT = -1

/** Apply CPU throttle rate to a CDP session. */
export const applyThrottle = async (session: CdpSessionHandle, rate: number): Promise<void> => {
	await session.sendAndWait('Emulation.setCPUThrottlingRate', { rate })
}

/** Clear CPU throttle (reset to rate 1). */
export const clearThrottle = async (session: CdpSessionHandle): Promise<void> => {
	await session.sendAndWait('Emulation.setCPUThrottlingRate', { rate: 1 })
}

/**
 * Apply network conditions to a CDP session.
 *
 * Chrome only throttles a session whose Network domain is enabled: without it the call succeeds,
 * the document request slows down, and every subresource and `fetch` stays at full speed. So this
 * enables the domain itself instead of relying on network capture, which is off unless the watcher
 * was started with it. The bare `Network.enable` matches the one capture sends (`networkCapture.ts`),
 * so neither resets the other's buffer sizes.
 */
export const applyNetworkThrottle = async (session: CdpSessionHandle, state: NetworkThrottleState): Promise<void> => {
	await session.sendAndWait('Network.enable')
	await session.sendAndWait('Network.emulateNetworkConditions', {
		offline: state.offline,
		latency: state.latencyMs,
		downloadThroughput: toThroughput(state.downloadKbps),
		uploadThroughput: toThroughput(state.uploadKbps),
	})
}

/** Restore normal network conditions. The Network domain stays enabled: capture may be using it. */
export const clearNetworkThrottle = async (session: CdpSessionHandle): Promise<void> => {
	await session.sendAndWait('Network.emulateNetworkConditions', {
		offline: false,
		latency: 0,
		downloadThroughput: UNLIMITED_THROUGHPUT,
		uploadThroughput: UNLIMITED_THROUGHPUT,
	})
}

const toThroughput = (kbps: number | undefined): number => (kbps == null ? UNLIMITED_THROUGHPUT : kbps * BYTES_PER_SECOND_PER_KBPS)
