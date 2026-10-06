import crypto from 'node:crypto'
import { BIND_TICKET_PREFIX, type WatcherRecord } from '@vforsh/argus-core'
import { buildWatcherUrl } from '../../watchers/requestWatcher.js'
import type { LiveControl } from './liveControls.js'

/**
 * Find a live control that actually serves the static bind page. Ownership/version metadata is
 * not a capability check. The probe ticket is never persisted or opened in a browser.
 */
export const findBindPageServer = async (controls: LiveControl[]): Promise<WatcherRecord | null> => {
	for (const { watcher } of controls) {
		const ticket = `${BIND_TICKET_PREFIX}${crypto.randomUUID()}`
		try {
			const response = await fetch(buildWatcherUrl(watcher, '/bind', new URLSearchParams({ ticket })), { signal: AbortSignal.timeout(1_500) })
			if (response.ok && response.headers.get('content-type')?.includes('text/html') && (await response.text()).includes(ticket)) {
				return watcher
			}
			await response.body?.cancel()
		} catch {
			// A live old host can lack the route; keep looking among the other controls.
		}
	}
	return null
}
