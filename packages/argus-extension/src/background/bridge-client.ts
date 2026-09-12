import { recordLifecycle, recordLifecycleError } from './lifecycle-journal.js'
import { messageEvidence, shouldJournalMessage } from '@vforsh/argus-core/diagnostic-events'
/**
 * Native Messaging client for communicating with argus-watcher (extension mode).
 * Handles connection lifecycle, message serialization, and reconnection.
 */

import { NATIVE_MESSAGING_PROTOCOL_VERSION, type ExtensionToHost, type HostToExtension } from '../types/messages.js'

export type MessageHandler<Inbound> = (message: Inbound) => void
export type ConnectionHandler = () => void
export type BridgeClientOptions = {
	autoReconnect?: boolean
}

export class BridgeClient<Inbound = HostToExtension, Outbound = ExtensionToHost> {
	private port: chrome.runtime.Port | null = null
	private readonly diagnosticChannel = crypto.randomUUID()
	private hostName: string
	private messageHandlers = new Set<MessageHandler<Inbound>>()
	private disconnectHandler: ConnectionHandler | null = null
	private reconnectAttempts = 0
	private maxReconnectAttempts = 5
	private reconnectDelay = 1000
	private autoReconnect: boolean
	private reconnectEnabled = true
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null

	constructor(hostName: string = 'com.vforsh.argus.bridge', options: BridgeClientOptions = {}) {
		this.hostName = hostName
		this.autoReconnect = options.autoReconnect ?? true
	}

	/**
	 * Set handler for incoming messages from the host.
	 */
	onMessage(handler: MessageHandler<Inbound>): void {
		this.messageHandlers.add(handler)
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

		this.reconnectEnabled = true
		this.clearReconnectTimer()
		recordLifecycle('bridge.connect.attempt', { host: this.hostName, channel: this.diagnosticChannel, attempt: this.reconnectAttempts })

		try {
			const port = chrome.runtime.connectNative(this.hostName)
			this.port = port

			port.onMessage.addListener((message: Inbound) => {
				if (this.port !== port) return
				const metadata = messageEvidence(message)
				if (shouldJournalMessage(metadata))
					recordLifecycle('bridge.received', { host: this.hostName, channel: this.diagnosticChannel, ...metadata })
				if (metadata.type === 'host_info' && metadata.protocolVersion === NATIVE_MESSAGING_PROTOCOL_VERSION) this.reconnectAttempts = 0
				for (const handler of this.messageHandlers) {
					handler(message)
				}
			})

			port.onDisconnect.addListener(() => {
				const error = chrome.runtime.lastError
				if (this.port !== port) return
				recordLifecycleError('bridge.disconnected', error?.message ?? 'unknown', { host: this.hostName, channel: this.diagnosticChannel })
				console.log('[BridgeClient] Disconnected:', error?.message ?? 'unknown reason')

				this.port = null

				if (this.disconnectHandler) {
					this.disconnectHandler()
				}

				// Attempt reconnection
				this.scheduleReconnect()
			})

			console.log('[BridgeClient] Connected to', this.hostName)

			return true
		} catch (err) {
			recordLifecycleError('bridge.connect.failed', err, { host: this.hostName, channel: this.diagnosticChannel })
			console.error('[BridgeClient] Failed to connect:', err)
			this.scheduleReconnect()
			return false
		}
	}

	/**
	 * Disconnect from the Native Messaging host.
	 */
	disconnect(): void {
		this.reconnectEnabled = false
		this.clearReconnectTimer()
		if (this.port) {
			const port = this.port
			this.port = null
			port.disconnect()
		}
	}

	/**
	 * Send a message to the Native Messaging host.
	 */
	send(message: Outbound): boolean {
		if (!this.port) {
			console.warn('[BridgeClient] Cannot send, not connected')
			return false
		}

		try {
			this.port.postMessage(message)
			const metadata = messageEvidence(message)
			if (shouldJournalMessage(metadata)) recordLifecycle('bridge.sent', { host: this.hostName, channel: this.diagnosticChannel, ...metadata })
			return true
		} catch (err) {
			recordLifecycleError('bridge.send.failed', err, { host: this.hostName, channel: this.diagnosticChannel })
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

	private clearReconnectTimer(): void {
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
		this.reconnectTimer = null
	}

	/** Schedule a reconnection attempt with exponential backoff. */
	private scheduleReconnect(): void {
		if (!this.autoReconnect || !this.reconnectEnabled || this.reconnectTimer) {
			return
		}

		if (this.reconnectAttempts >= this.maxReconnectAttempts) {
			recordLifecycle('bridge.reconnect.exhausted', { host: this.hostName, channel: this.diagnosticChannel, attempt: this.reconnectAttempts })
			console.log('[BridgeClient] Max reconnection attempts reached')
			return
		}

		const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts)
		this.reconnectAttempts++

		console.log(`[BridgeClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`)

		const scheduledAt = performance.now()
		recordLifecycle('bridge.reconnect.scheduled', {
			host: this.hostName,
			channel: this.diagnosticChannel,
			delayMs: delay,
			attempt: this.reconnectAttempts,
		})
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null
			if (!this.reconnectEnabled) return
			recordLifecycle('bridge.reconnect.fired', {
				host: this.hostName,
				channel: this.diagnosticChannel,
				eventLoopDelayMs: Math.max(0, performance.now() - scheduledAt - delay),
			})
			this.connect()
		}, delay)
	}
}
