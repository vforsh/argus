/**
 * Native Messaging protocol handler for stdin/stdout communication.
 * Chrome Native Messaging uses length-prefixed 32-bit messages.
 */

import type { ExtensionToHost, HostToExtension } from './types.js'

export type NativeMessagingHandler = {
	onMessage: (callback: (message: ExtensionToHost) => void) => void
	onDisconnect: (callback: () => void) => void
	send: (message: HostToExtension) => void
	start: () => void
	stop: () => void
}

/**
 * Create a Native Messaging handler for stdin/stdout communication.
 * Messages are length-prefixed with a 32-bit little-endian integer.
 */
export const createNativeMessaging = (): NativeMessagingHandler => {
	let messageCallback: ((message: ExtensionToHost) => void) | null = null
	let disconnectCallback: (() => void) | null = null
	let buffer = Buffer.alloc(0)
	let running = false

	const processBuffer = (): void => {
		// Need at least 4 bytes for the length prefix
		while (buffer.length >= 4) {
			const messageLength = buffer.readUInt32LE(0)

			// Wait for the full message
			if (buffer.length < 4 + messageLength) {
				break
			}

			// Extract the message
			const messageBytes = buffer.subarray(4, 4 + messageLength)
			buffer = buffer.subarray(4 + messageLength)

			try {
				const message = JSON.parse(messageBytes.toString('utf8')) as ExtensionToHost
				if (messageCallback) {
					messageCallback(message)
				}
			} catch (err) {
				console.error('[NativeMessaging] Failed to parse message:', err)
			}
		}
	}

	const onData = (chunk: Buffer): void => {
		buffer = Buffer.concat([buffer, chunk])
		processBuffer()
	}

	const onEnd = (): void => {
		running = false
		if (disconnectCallback) {
			disconnectCallback()
		}
	}

	return {
		onMessage: (callback) => {
			messageCallback = callback
		},

		onDisconnect: (callback) => {
			disconnectCallback = callback
		},

		send: (message) => {
			if (!running) {
				return
			}

			const messageStr = JSON.stringify(message)
			const messageBytes = Buffer.from(messageStr, 'utf8')
			const lengthPrefix = Buffer.alloc(4)
			lengthPrefix.writeUInt32LE(messageBytes.length, 0)

			process.stdout.write(lengthPrefix)
			process.stdout.write(messageBytes)
		},

		start: () => {
			if (running) {
				return
			}
			running = true

			console.error('[NativeMessaging] Starting...')
			console.error('[NativeMessaging] stdin.isTTY:', process.stdin.isTTY)
			console.error('[NativeMessaging] stdin.readable:', process.stdin.readable)

			// Set stdin to raw mode for binary data
			if (process.stdin.setRawMode) {
				process.stdin.setRawMode(true)
			}
			process.stdin.resume()
			process.stdin.on('data', onData)
			process.stdin.on('end', onEnd)
			process.stdin.on('close', onEnd)

			console.error('[NativeMessaging] Started, listening on stdin')
		},

		stop: () => {
			if (!running) {
				return
			}
			running = false

			process.stdin.removeListener('data', onData)
			process.stdin.removeListener('end', onEnd)
			process.stdin.removeListener('close', onEnd)
			process.stdin.pause()
		},
	}
}
