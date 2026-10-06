import { readRegistry, type ApiResult, type StatusResponse, type WatcherRecord } from '@vforsh/argus-core'
import { formatError } from '../../cli/parse.js'
import { fetchWatcherJson } from '../../watchers/requestWatcher.js'

/** Compare run identity and endpoint; mutable heartbeat timestamps and target selectors are ignored. */
export const sameWatcherRun = (expected: WatcherRecord, actual: WatcherRecord | undefined): boolean =>
	actual != null &&
	expected.id === actual.id &&
	expected.pid === actual.pid &&
	expected.ownerId === actual.ownerId &&
	expected.startedAt === actual.startedAt &&
	expected.host === actual.host &&
	expected.port === actual.port &&
	expected.source === actual.source &&
	expected.extensionRole === actual.extensionRole

/**
 * Read status from a pinned endpoint only while the registry and HTTP identity still match it.
 * A missing owner token on a peer that previously supplied one is also a mismatch.
 * Returns a typed failure instead of resolving the same name to a replacement process.
 */
export const readPinnedWatcherStatus = async (watcher: WatcherRecord): Promise<ApiResult<StatusResponse>> => {
	try {
		const { registry } = await readRegistry()
		if (!sameWatcherRun(watcher, registry.watchers[watcher.id])) return identityFailure(watcher.id)
		const status = await fetchWatcherJson<ApiResult<StatusResponse>>(watcher, { path: '/status', timeoutMs: 1_500, returnErrorResponse: true })
		if (!status.ok) return status
		if (status.id !== watcher.id || status.pid !== watcher.pid || (watcher.ownerId != null && status.ownerId !== watcher.ownerId)) {
			return identityFailure(watcher.id)
		}
		return status
	} catch (error) {
		return { ok: false, error: { message: `${watcher.id}: ${formatError(error)}` } }
	}
}

const identityFailure = (id: string): { ok: false; error: { code: 'registration_conflict'; message: string } } => ({
	ok: false,
	error: { code: 'registration_conflict', message: `Watcher ${id} changed owner or endpoint; refusing to act on its replacement.` },
})
