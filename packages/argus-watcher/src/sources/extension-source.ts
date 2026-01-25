/**
 * Extension source for CDP access via Chrome extension Native Messaging.
 * Wraps SessionManager and provides a unified source interface.
 */

import type { LogEvent, LogLevel } from '@vforsh/argus-core'
import { previewStringify } from '@vforsh/argus-core'
import { createNativeMessaging } from '../native-messaging/messaging.js'
import { SessionManager, type ExtensionSession } from '../native-messaging/session-manager.js'
import type { TabInfo } from '../native-messaging/types.js'
import type { CdpSourceHandle, CdpSourceTarget, CdpSourceBaseOptions } from './types.js'
import type { CdpSessionHandle } from '../cdp/connection.js'

/**
 * Options for creating an extension source.
 */
export type ExtensionSourceOptions = CdpSourceBaseOptions

/**
 * Create an extension source that connects to Chrome via Native Messaging.
 * Returns a handle that can be used to control the source and access CDP session.
 */
export const createExtensionSource = (options: ExtensionSourceOptions): CdpSourceHandle => {
	const { events, ignoreMatcher, stripUrlPrefixes } = options

	const messaging = createNativeMessaging()
	let currentSession: ExtensionSession | null = null
	let stopping = false

	// Create session manager with event handlers
	const sessionManager = new SessionManager(messaging, {
		onAttach: (session: ExtensionSession) => {
			console.error(`[ExtensionSource] Tab attached: ${session.tabId} - ${session.url}`)

			currentSession = session

			// Enable Runtime domain to receive console events
			sessionManager.enableDomain(session.tabId, 'Runtime')
			sessionManager.enableDomain(session.tabId, 'Page')

			// Subscribe to console events
			session.handle.onEvent('Runtime.consoleAPICalled', (params) => {
				const logEvent = toConsoleEvent(params, session, { ignoreMatcher, stripUrlPrefixes })
				events.onLog(logEvent)
			})

			// Subscribe to exception events
			session.handle.onEvent('Runtime.exceptionThrown', (params) => {
				const logEvent = toExceptionEvent(params, session, { ignoreMatcher, stripUrlPrefixes })
				events.onLog(logEvent)
			})

			// Notify status change
			const target: CdpSourceTarget = {
				id: String(session.tabId),
				title: session.title,
				url: session.url,
				type: 'page',
				faviconUrl: session.faviconUrl,
				attached: true,
			}

			events.onStatus({
				attached: true,
				target: {
					title: session.title,
					url: session.url,
					type: 'page',
					parentId: null,
				},
				reason: null,
			})

			void events.onAttach?.(session.handle, target)
		},

		onDetach: (tabId: number, reason: string) => {
			console.error(`[ExtensionSource] Tab detached: ${tabId} - ${reason}`)

			if (currentSession?.tabId === tabId) {
				currentSession = null
			}

			events.onStatus({
				attached: false,
				target: null,
				reason,
			})

			events.onDetach?.(reason)
		},

		onTabsUpdated: () => {
			// Tabs list updated - no action needed
		},
	})

	// Create a proxy session handle that delegates to the current session
	const proxySession: CdpSessionHandle = {
		isAttached: () => currentSession?.handle.isAttached() ?? false,

		sendAndWait: async (method, params, options) => {
			const session = currentSession
			if (!session) {
				const error = new Error('No tab attached via extension')
				;(error as Error & { code?: string }).code = 'cdp_not_attached'
				throw error
			}
			return session.handle.sendAndWait(method, params, options)
		},

		onEvent: (method, handler) => {
			// For proxy session, we need to track all handlers and replay them
			// when a new session is attached. For now, just use the current session.
			if (!currentSession) {
				// Return a no-op unsubscribe function
				return () => {}
			}
			return currentSession.handle.onEvent(method, handler)
		},
	}

	// Start Native Messaging
	messaging.start()
	messaging.onDisconnect(() => {
		console.error('[ExtensionSource] Extension disconnected')
		if (!stopping) {
			events.onStatus({
				attached: false,
				target: null,
				reason: 'extension_disconnected',
			})
			events.onDetach?.('extension_disconnected')
		}
	})

	const stop = async (): Promise<void> => {
		stopping = true
		messaging.stop()
	}

	const listTargets = async (): Promise<CdpSourceTarget[]> => {
		const tabs = await sessionManager.listTabs()
		return tabs.map(tabToTarget)
	}

	const attachTarget = (targetId: number): void => {
		sessionManager.attachTab(targetId)
	}

	const detachTarget = (targetId: number): void => {
		sessionManager.detachTab(targetId)
	}

	return {
		session: proxySession,
		stop,
		listTargets,
		attachTarget,
		detachTarget,
	}
}

/**
 * Convert TabInfo to CdpSourceTarget.
 */
const tabToTarget = (tab: TabInfo): CdpSourceTarget => ({
	id: String(tab.tabId),
	title: tab.title,
	url: tab.url,
	type: 'page',
	faviconUrl: tab.faviconUrl,
	attached: tab.attached,
})

/**
 * Convert Runtime.consoleAPICalled event to LogEvent.
 */
const toConsoleEvent = (
	params: unknown,
	session: ExtensionSession,
	config: { ignoreMatcher?: ((url: string) => boolean) | null; stripUrlPrefixes?: string[] },
): Omit<LogEvent, 'id'> => {
	const record = params as {
		type?: LogLevel | string
		args?: Array<{ type: string; value?: unknown; description?: string }>
		timestamp?: number
		stackTrace?: { callFrames?: Array<{ url: string; lineNumber: number; columnNumber: number }> }
	}

	const args = record.args?.map((a) => a.value) ?? []
	const text = formatArgs(record.args ?? [])

	const frame = selectBestFrame(record.stackTrace?.callFrames, config.ignoreMatcher)

	return {
		ts: record.timestamp ?? Date.now(),
		level: normalizeLevel(record.type ?? 'log'),
		text,
		args,
		source: 'console',
		file: applyStripPrefixes(frame?.url ?? null, config.stripUrlPrefixes),
		line: frame?.lineNumber != null ? frame.lineNumber + 1 : null,
		column: frame?.columnNumber != null ? frame.columnNumber + 1 : null,
		pageUrl: session.url,
		pageTitle: session.title,
	}
}

/**
 * Convert Runtime.exceptionThrown event to LogEvent.
 */
const toExceptionEvent = (
	params: unknown,
	session: ExtensionSession,
	config: { ignoreMatcher?: ((url: string) => boolean) | null; stripUrlPrefixes?: string[] },
): Omit<LogEvent, 'id'> => {
	const record = params as {
		timestamp?: number
		exceptionDetails?: {
			text?: string
			exception?: { description?: string; value?: unknown }
			stackTrace?: { callFrames?: Array<{ url: string; lineNumber: number; columnNumber: number }> }
		}
	}

	const details = record.exceptionDetails
	const text = details?.exception?.description ?? details?.text ?? 'Exception'
	const args = details?.exception ? [details.exception.value ?? details.exception.description] : []

	const frame = selectBestFrame(details?.stackTrace?.callFrames, config.ignoreMatcher)

	return {
		ts: record.timestamp ?? Date.now(),
		level: 'exception',
		text,
		args,
		source: 'exception',
		file: applyStripPrefixes(frame?.url ?? null, config.stripUrlPrefixes),
		line: frame?.lineNumber != null ? frame.lineNumber + 1 : null,
		column: frame?.columnNumber != null ? frame.columnNumber + 1 : null,
		pageUrl: session.url,
		pageTitle: session.title,
	}
}

/**
 * Format console args for display.
 */
const formatArgs = (args: Array<{ type: string; value?: unknown; description?: string }>): string => {
	if (args.length === 0) {
		return ''
	}

	return args
		.map((arg) => {
			if (arg.value !== undefined) {
				return typeof arg.value === 'string' ? arg.value : previewStringify(arg.value)
			}
			return arg.description ?? `[${arg.type}]`
		})
		.join(' ')
}

/**
 * Normalize console log type to LogLevel.
 */
const normalizeLevel = (type: LogLevel | string): LogEvent['level'] => {
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
		case 'exception':
			return type === 'exception' ? 'exception' : 'error'
		default:
			return 'log'
	}
}

type CallFrame = { url: string; lineNumber: number; columnNumber: number }

/**
 * Select the best frame from the stack trace (first non-ignored frame).
 */
const selectBestFrame = (frames: CallFrame[] | undefined, ignoreMatcher: ((url: string) => boolean) | null | undefined): CallFrame | null => {
	if (!frames || frames.length === 0) {
		return null
	}

	if (!ignoreMatcher) {
		return frames[0] ?? null
	}

	for (const frame of frames) {
		if (frame.url && !ignoreMatcher(frame.url)) {
			return frame
		}
	}

	// Fall back to first frame if all are ignored
	return frames[0] ?? null
}

/**
 * Apply strip prefixes to a file URL.
 */
const applyStripPrefixes = (file: string | null, prefixes: string[] | undefined): string | null => {
	if (!file || !prefixes || prefixes.length === 0) {
		return file
	}

	for (const prefix of prefixes) {
		if (file.startsWith(prefix)) {
			return file.slice(prefix.length)
		}
	}

	return file
}
