/**
 * Native Messaging host command for Chrome extension.
 *
 * This command is invoked by Chrome when the extension connects via
 * chrome.runtime.connectNative(). It communicates over stdin/stdout
 * using Chrome's Native Messaging protocol (length-prefixed JSON).
 */

import { startWatcher, type WatcherHandle } from '@vforsh/argus-watcher'

export type NativeHostOptions = {
	id?: string
	json?: boolean
}

export const runWatcherNativeHost = async (options: NativeHostOptions): Promise<void> => {
	const watcherId = options.id?.trim() || 'extension'

	let handle: WatcherHandle
	try {
		handle = await startWatcher({
			id: watcherId,
			source: 'extension',
			host: '127.0.0.1',
			port: 0,
			pageIndicator: { enabled: false },
		})
	} catch (error) {
		// Write error to stderr (Native Messaging reads stdout only)
		console.error(`Failed to start watcher: ${error instanceof Error ? error.message : error}`)
		process.exit(1)
	}

	// Log to stderr for debugging (stdout is reserved for Native Messaging)
	console.error(`[NativeHost] Watcher started: id=${handle.watcher.id} port=${handle.watcher.port}`)

	const cleanup = async (): Promise<void> => {
		try {
			await handle.close()
		} catch {
			// Ignore
		}
	}

	process.on('SIGINT', () => {
		void cleanup().then(() => process.exit(0))
	})

	process.on('SIGTERM', () => {
		void cleanup().then(() => process.exit(0))
	})

	// Keep process running - Native Messaging will handle stdin/stdout
	await new Promise(() => {})
}
