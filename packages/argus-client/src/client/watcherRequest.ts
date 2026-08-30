import type { WatcherRecord, ResponseData } from '@vforsh/argus-core'
import { isHttpResponseError } from '@vforsh/argus-core'
import type { HttpOptions } from '../http/fetchJson.js'
import { fetchJson } from '../http/fetchJson.js'
import { readAndPruneRegistry, removeWatcherAndPersist } from '../registry/readAndPruneRegistry.js'

type RegistryContext = {
	registryPath?: string
	ttlMs: number
}

type WatcherRequestOptions = {
	path: string
	query?: URLSearchParams
	timeoutMs?: number
	method?: HttpOptions['method']
	body?: unknown
}

export const withWatcher = async <T>(context: RegistryContext, watcherId: string, callback: (watcher: WatcherRecord) => Promise<T>): Promise<T> => {
	const registry = await readAndPruneRegistry({ registryPath: context.registryPath, ttlMs: context.ttlMs })
	const watcher = registry.watchers[watcherId]
	if (!watcher) {
		throw new Error(`Watcher not found: ${watcherId}`)
	}

	return callback(watcher)
}

export const requestWatcher = async <T>(
	context: RegistryContext,
	watcherId: string,
	options: WatcherRequestOptions,
): Promise<{ watcher: WatcherRecord; data: T }> =>
	withWatcher(context, watcherId, async (watcher) => {
		try {
			const data = await fetchJson<T>(buildWatcherUrl(watcher, options.path, options.query), {
				timeoutMs: options.timeoutMs,
				method: options.method,
				body: options.body,
			})
			return { watcher, data }
		} catch (error) {
			// The watcher answered and rejected this request, so it is demonstrably alive.
			// Evicting it here would break every later call in the process over one bad
			// selector or a page that happens to be mid-navigation.
			if (isHttpResponseError(error)) {
				throw new Error(`${watcher.id}: ${error.message}`)
			}

			await removeWatcherAndPersist(watcher.id, context.registryPath)
			throw new Error(formatWatcherTransportError(watcher, error))
		}
	})

const buildWatcherUrl = (watcher: Pick<WatcherRecord, 'host' | 'port'>, path: string, query?: URLSearchParams): string => {
	const qs = query?.toString()
	return `http://${watcher.host}:${watcher.port}${path}${qs ? `?${qs}` : ''}`
}

const formatWatcherTransportError = (watcher: Pick<WatcherRecord, 'id'>, error: unknown): string =>
	`${watcher.id}: failed to reach watcher (${formatUnknownError(error)})`

const formatUnknownError = (error: unknown): string => {
	if (!error) {
		return 'unknown error'
	}
	if (error instanceof Error) {
		return error.message
	}
	return String(error)
}

/**
 * Issue a watcher request and return the response payload without its `ok` discriminant.
 *
 * SDK methods throw on failure, so the caller already knows `ok` was `true`; stripping it
 * here means a method never has to re-list the response fields to drop one of them, and a
 * new protocol field reaches callers without touching the method.
 */
export const requestWatcherData = async <T extends { ok: true }>(
	context: RegistryContext,
	watcherId: string,
	options: WatcherRequestOptions,
): Promise<ResponseData<T>> => {
	const { data } = await requestWatcher<T>(context, watcherId, options)
	const { ok: _ok, ...rest } = data
	return rest
}
