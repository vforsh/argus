import type { ArgusClient, ArgusClientOptions, WatcherClient } from '../types.js'
import { createClientContext } from './context.js'
import { createCaptureMethods } from './methods/capture.js'
import { createEvalMethods } from './methods/evalMethods.js'
import { createInspectMethods } from './methods/inspect.js'
import { createPageMethods } from './methods/page.js'
import { createWatcherClient } from './watcherHandle.js'

/**
 * Create an Argus client for driving a watcher over its HTTP API.
 *
 * Throws on invalid input, missing watcher, or unreachable watcher.
 * Note: registry-backed calls prune stale entries and remove unreachable watchers.
 *
 * @example
 * const client = createArgusClient()
 * const ready = await client.evalUntil('playground', 'window.app?.ready')
 *
 * @example Watcher-bound handle
 * const page = createArgusClient().watcher('playground')
 * await page.reload({ ignoreCache: true })
 * const count = await page.evalValue<number>('document.querySelectorAll("li").length')
 */
export const createArgusClient = (options: ArgusClientOptions = {}): ArgusClient => {
	const ctx = createClientContext(options)

	const client: ArgusClient = {
		...createInspectMethods(ctx),
		...createEvalMethods(ctx),
		...createPageMethods(ctx),
		...createCaptureMethods(ctx),
		watcher: (watcherId: string): WatcherClient => createWatcherClient(client, watcherId),
	}

	return client
}
