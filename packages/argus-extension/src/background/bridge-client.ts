/**
 * Native Messaging client for communicating with argus-bridge.
 * Handles connection lifecycle, message serialization, and reconnection.
 */

import type { ExtensionToHost, HostToExtension } from '../types/messages.js'

export type MessageHandler = (message: HostToExtension) => void
export type ConnectionHandler = () => void

export class BridgeClient {
	private port: chrome.runtime.Port | null = null
	private hostName: string
	private messageHandler: MessageHandler | null = null
	private connectHandler: ConnectionHandler | null = null
	private disconnectHandler: ConnectionHandler | null = null
	private reconnectAttempts = 0
	private maxReconnectAttempts = 5
	private reconnectDelay = 1000

	constructor(hostName: string = 'com.vforsh.argus.bridge') {
		this.hostName = hostName
	}

	/**
	 * Set handler for incoming messages from the host.
	 */
	onMessage(handler: MessageHandler): void {
		this.messageHandler = handler
	}

	/**
	 * Set handler for successful connection.
	 */
	onConnect(handler: ConnectionHandler): void {
		this.connectHandler = handler
	}

	/**
	 * Set handler for disconnection.
	 */
	onDisconnect(handler: ConnectionHandler): void {
		this.disconnectHandler = handler
	}

	/**
	 * Connect to the Native Messaging host.
	 */
	connect(): boolean {
		if (this.port) {
			return true // Already connected
		}

		try {
			this.port = chrome.runtime.connectNative(this.hostName)

			this.port.onMessage.addListener((message: HostToExtension) => {
				this.reconnectAttempts = 0 // Reset on successful message
				if (this.messageHandler) {
					this.messageHandler(message)
				}
			})

			this.port.onDisconnect.addListener(() => {
				const error = chrome.runtime.lastError
				console.log('[BridgeClient] Disconnected:', error?.message ?? 'unknown reason')

				this.port = null

				if (this.disconnectHandler) {
					this.disconnectHandler()
				}

				// Attempt reconnection
				this.scheduleReconnect()
			})

			console.log('[BridgeClient] Connected to', this.hostName)
			this.reconnectAttempts = 0

			if (this.connectHandler) {
				this.connectHandler()
			}

			return true
		} catch (err) {
			console.error('[BridgeClient] Failed to connect:', err)
			this.scheduleReconnect()
			return false
		}
	}

	/**
	 * Disconnect from the Native Messaging host.
	 */
	disconnect(): void {
		if (this.port) {
			this.port.disconnect()
			this.port = null
		}
	}

	/**
	 * Send a message to the Native Messaging host.
	 */
	send(message: ExtensionToHost): boolean {
		if (!this.port) {
			console.warn('[BridgeClient] Cannot send, not connected')
			return false
		}

		try {
			this.port.postMessage(message)
			return true
		} catch (err) {
			console.error('[BridgeClient] Send failed:', err)
			return false
		}
	}

	/**
	 * Check if connected to the host.
	 */
	isConnected(): boolean {
		return this.port !== null
	}

	/**
	 * Schedule a reconnection attempt with exponential backoff.
	 */
	private scheduleReconnect(): void {
		if (this.reconnectAttempts >= this.maxReconnectAttempts) {
			console.log('[BridgeClient] Max reconnection attempts reached')
			return
		}

		const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts)
		this.reconnectAttempts++

		console.log(`[BridgeClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`)

		setTimeout(() => {
			this.connect()
		}, delay)
	}
}
