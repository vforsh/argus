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
	role?: string
	json?: boolean
}

export const runWatcherNativeHost = async (options: NativeHostOptions): Promise<void> => {
	const role = options.role?.trim() || 'tab'
	if (role !== 'tab' && role !== 'control') {
		console.error(`Invalid native host role: ${role}. Expected "tab" or "control".`)
		process.exit(2)
	}

	let handle: WatcherHandle
	try {
		const watcherId = role === 'tab' ? await resolveTabWatcherId(options.id?.trim()) : options.id?.trim() || 'extension'
		handle = await startWatcher({
			id: watcherId,
			source: 'extension',
			extensionRole: role,
			host: '127.0.0.1',
			port: 0,
			net: { enabled: true },
			pageIndicator: { enabled: role === 'tab' },
		})
	} catch (error) {
		// Write error to stderr (Native Messaging reads stdout only)
		console.error(`Failed to start watcher: ${error instanceof Error ? error.message : error}`)
		process.exit(1)
	}

	// Log to stderr for debugging (stdout is reserved for Native Messaging)
	console.error(`[NativeHost] Watcher started: id=${handle.watcher.id} role=${role} port=${handle.watcher.port}`)

	const cleanup = async (): Promise<void> => {
		try {
			await handle.close()
		} catch {
			// Ignore
		}
	}
	let shuttingDown = false
	const shutdown = (): void => {
		if (shuttingDown) {
			return
		}
		shuttingDown = true
		void cleanup().then(() => process.exit(0))
	}

	process.on('SIGINT', () => {
		shutdown()
	})

	process.on('SIGTERM', () => {
		shutdown()
	})

	// Chrome closes stdin when the extension disconnects the Native Messaging port.
	process.stdin.on('end', shutdown)
	process.stdin.on('close', shutdown)

	// Keep process running - Native Messaging will handle stdin/stdout
	await new Promise(() => {})
}

const resolveTabWatcherId = async (fallback: string | undefined): Promise<string> => {
	const message = await new Promise<{ type?: string; watcherId?: string }>((resolve, reject) => {
		let buffer = Buffer.alloc(0)
		const timeout = setTimeout(() => {
			cleanup()
			reject(new Error('Timed out waiting for extension tab watcher init'))
		}, 3000)

		const cleanup = (): void => {
			clearTimeout(timeout)
			process.stdin.removeListener('data', onData)
			process.stdin.removeListener('end', onDisconnect)
			process.stdin.removeListener('close', onDisconnect)
			process.stdin.pause()
		}

		const onDisconnect = (): void => {
			cleanup()
			reject(new Error('Extension disconnected before tab watcher init'))
		}

		const onData = (chunk: Buffer): void => {
			buffer = Buffer.concat([buffer, chunk])
			if (buffer.length < 4) {
				return
			}
			const messageLength = buffer.readUInt32LE(0)
			if (buffer.length < 4 + messageLength) {
				return
			}
			const messageBytes = buffer.subarray(4, 4 + messageLength)
			cleanup()
			try {
				resolve(JSON.parse(messageBytes.toString('utf8')) as { type?: string; watcherId?: string })
			} catch (error) {
				reject(error instanceof Error ? error : new Error(String(error)))
			}
		}

		process.stdin.setRawMode?.(true)
		process.stdin.resume()
		process.stdin.on('data', onData)
		process.stdin.on('end', onDisconnect)
		process.stdin.on('close', onDisconnect)
	})

	if (message.type !== 'init_tab_watcher') {
		throw new Error(`Expected init_tab_watcher, received ${message.type ?? 'unknown message'}`)
	}
	return message.watcherId?.trim() || fallback || 'extension'
}
