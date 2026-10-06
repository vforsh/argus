import { delay, type EmulationStatusResponse, type StatusResponse } from '@vforsh/argus-core'
import type { WatcherHandle } from '@vforsh/argus-watcher'
import { fetchWatcherJson } from '../watchers/requestWatcher.js'

/**
 * Wait up to 15s for a real CDP attachment before announcing startup success.
 * @param handle Newly started watcher to poll.
 * @param hasViewport Also require its requested viewport to have applied successfully.
 * @throws When startup never attaches or viewport application fails.
 */
export const waitForStartReady = async (handle: WatcherHandle, hasViewport: boolean): Promise<void> => {
	const deadline = Date.now() + 15_000
	while (Date.now() < deadline) {
		const status = await fetchWatcherJson<StatusResponse>(handle.watcher, { path: '/status', timeoutMs: 1_000 })
		if (status.attached) {
			if (!hasViewport) return
			const emulation = await fetchWatcherJson<EmulationStatusResponse>(handle.watcher, { path: '/emulation', timeoutMs: 1_000 })
			if (emulation.applied) return
			if (emulation.lastError) throw new Error(`Startup viewport failed: ${emulation.lastError.message}`)
		}
		await delay(100)
	}
	throw new Error(`Watcher ${handle.watcher.id} did not attach to a matching CDP target within 15000ms.`)
}
