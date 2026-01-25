/**
 * Argus Bridge - Native Messaging host for Chrome extension CDP access.
 *
 * This module provides the main entry point for starting the bridge,
 * which connects to the Argus Chrome extension via Native Messaging
 * and exposes a watcher-compatible HTTP API.
 */

import type { LogEvent } from '@vforsh/argus-core'
import { createNativeMessaging } from './native-messaging.js'
import { SessionManager, type ExtensionSession } from './session-manager.js'
import { LogBuffer } from './log-buffer.js'
import { startHttpServer, type BridgeRecord } from './http-server.js'
import Emittery from 'emittery'

export type StartBridgeOptions = {
	/** Unique bridge identifier. */
	id: string
	/** Host/interface to bind the HTTP server to. Defaults to `127.0.0.1`. */
	host?: string
	/** Port to bind the HTTP server to. Defaults to `0` (ephemeral). */
	port?: number
	/** Max buffered log events before older entries are dropped. Defaults to `50_000`. */
	bufferSize?: number
	/** Run without Native Messaging (for manual testing). */
	standalone?: boolean
}

export type BridgeHandle = {
	/** The bridge record (id, host, port, etc.). */
	bridge: BridgeRecord
	/** Event emitter for bridge lifecycle events. */
	events: Emittery<BridgeEventMap>
	/** Stop the bridge and release resources. */
	close: () => Promise<void>
}

export type BridgeEventMap = {
	tabAttached: { tabId: number; url: string; title: string }
	tabDetached: { tabId: number; reason: string }
	log: LogEvent
}

/**
 * Start the Argus bridge.
 *
 * Connects to the Chrome extension via Native Messaging and exposes
 * an HTTP API compatible with argus-watcher.
 */
export const startBridge = async (options: StartBridgeOptions): Promise<BridgeHandle> => {
	if (!options.id) {
		throw new Error('Bridge id is required')
	}

	const host = options.host ?? '127.0.0.1'
	const port = options.port ?? 0
	const bufferSize = options.bufferSize ?? 50_000
	const startedAt = Date.now()

	const events = new Emittery<BridgeEventMap>()
	const buffer = new LogBuffer(bufferSize)
	const messaging = createNativeMessaging()

	let closing = false

	// Create session manager with event handlers
	const sessionManager = new SessionManager(messaging, {
		onAttach: (session: ExtensionSession) => {
			console.error(`[Bridge] Tab attached: ${session.tabId} - ${session.url}`)

			// Enable Runtime domain to receive console events
			sessionManager.enableDomain(session.tabId, 'Runtime')
			sessionManager.enableDomain(session.tabId, 'Page')

			void events.emit('tabAttached', {
				tabId: session.tabId,
				url: session.url,
				title: session.title,
			})

			// Subscribe to console events
			session.handle.onEvent('Runtime.consoleAPICalled', (params) => {
				const consoleEvent = params as {
					type: string
					args: Array<{ type: string; value?: unknown; description?: string }>
					timestamp: number
					stackTrace?: { callFrames: Array<{ url: string; lineNumber: number; columnNumber: number }> }
				}

				const text = consoleEvent.args
					.map((arg) => {
						if (arg.value !== undefined) {
							return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value)
						}
						return arg.description ?? `[${arg.type}]`
					})
					.join(' ')

				const logEvent = buffer.add({
					ts: consoleEvent.timestamp,
					level: mapConsoleType(consoleEvent.type),
					text,
					args: consoleEvent.args.map((a) => a.value),
					source: 'console',
					file: consoleEvent.stackTrace?.callFrames[0]?.url ?? null,
					line: consoleEvent.stackTrace?.callFrames[0]?.lineNumber ?? null,
					column: consoleEvent.stackTrace?.callFrames[0]?.columnNumber ?? null,
					pageUrl: null,
					pageTitle: null,
				})

				void events.emit('log', logEvent)
			})

			// Subscribe to exception events
			session.handle.onEvent('Runtime.exceptionThrown', (params) => {
				const exceptionEvent = params as {
					timestamp: number
					exceptionDetails: {
						text: string
						exception?: { description?: string }
						stackTrace?: { callFrames: Array<{ url: string; lineNumber: number; columnNumber: number }> }
					}
				}

				const text = exceptionEvent.exceptionDetails.exception?.description ?? exceptionEvent.exceptionDetails.text

				const logEvent = buffer.add({
					ts: exceptionEvent.timestamp,
					level: 'error',
					text,
					args: [],
					source: 'exception',
					file: exceptionEvent.exceptionDetails.stackTrace?.callFrames[0]?.url ?? null,
					line: exceptionEvent.exceptionDetails.stackTrace?.callFrames[0]?.lineNumber ?? null,
					column: exceptionEvent.exceptionDetails.stackTrace?.callFrames[0]?.columnNumber ?? null,
					pageUrl: null,
					pageTitle: null,
				})

				void events.emit('log', logEvent)
			})
		},

		onDetach: (tabId: number, reason: string) => {
			console.error(`[Bridge] Tab detached: ${tabId} - ${reason}`)
			void events.emit('tabDetached', { tabId, reason })
		},

		onTabsUpdated: () => {
			// Tabs list updated - no action needed
		},
	})

	const record: BridgeRecord = {
		id: options.id,
		host,
		port,
		pid: process.pid,
		cwd: process.cwd(),
		startedAt,
		updatedAt: Date.now(),
		source: 'extension',
	}

	// Start HTTP server
	const server = await startHttpServer({
		host,
		port,
		buffer,
		sessionManager,
		getBridgeRecord: () => record,
		onShutdown: () => {
			void close()
		},
	})

	record.port = server.port

	// Start Native Messaging unless running in standalone mode
	if (!options.standalone) {
		messaging.start()
		messaging.onDisconnect(() => {
			console.error('[Bridge] Extension disconnected')
			if (!closing) {
				void close()
			}
		})
	} else {
		console.error('[Bridge] Running in standalone mode (no Native Messaging)')
	}

	console.error(`[Bridge] Started on ${host}:${server.port}`)

	const close = async (): Promise<void> => {
		if (closing) {
			return
		}
		closing = true

		console.error('[Bridge] Shutting down...')

		messaging.stop()
		await server.close()
		events.clearListeners()

		console.error('[Bridge] Stopped')
	}

	return {
		bridge: record,
		events,
		close,
	}
}

/**
 * Map console API type to log level.
 */
const mapConsoleType = (type: string): LogEvent['level'] => {
	switch (type) {
		case 'log':
		case 'info':
		case 'debug':
		case 'dir':
		case 'dirxml':
		case 'table':
		case 'trace':
		case 'count':
		case 'timeEnd':
		case 'timeLog':
			return type === 'debug' ? 'debug' : type === 'info' ? 'info' : 'log'
		case 'warn':
		case 'warning':
			return 'warning'
		case 'error':
		case 'assert':
			return 'error'
		default:
			return 'log'
	}
}

export type { BridgeRecord } from './http-server.js'
export type { ExtensionSession } from './session-manager.js'
export type { TabInfo } from './types.js'
