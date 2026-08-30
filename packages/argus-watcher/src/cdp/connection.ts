import { createNotAttachedError } from '../errors.js'
import type { CdpEvent, CdpEventPayload, CdpMethod, CdpParams, CdpResult } from './protocol.js'

export type CdpEventMeta = {
	/** Child protocol session the event arrived on, or `null` for the root target. */
	sessionId: string | null
}

/** Handler for one CDP event, typed by the event it is registered for. */
export type CdpEventHandler<E extends CdpEvent = CdpEvent> = (params: CdpEventPayload<E>, meta: CdpEventMeta) => void

export type CdpSendOptions = {
	/** Optional timeout for this CDP command (ms). */
	timeoutMs?: number
	/** Optional child protocol session within the current root target. */
	sessionId?: string
}

export type CdpTargetContext =
	| { kind: 'page' }
	| {
			kind: 'frame'
			frameId: string
			executionContextId: number | null
			sessionId?: string | null
	  }

export type CdpSessionHandle = {
	isAttached: () => boolean
	/**
	 * Send one CDP command and await its result.
	 *
	 * Parameters and result are looked up from {@link CdpCommandMap} by method name, so an
	 * unknown method or a mistyped payload fails to compile. Use {@link sendUntypedCommand}
	 * for the rare call whose method is genuinely computed at runtime.
	 */
	sendAndWait: <M extends CdpMethod>(method: M, params?: CdpParams<M>, options?: CdpSendOptions) => Promise<CdpResult<M>>
	/** Subscribe to one CDP event. The handler receives that event's payload, not `unknown`. */
	onEvent: <E extends CdpEvent>(method: E, handler: CdpEventHandler<E>) => () => void
	/** Active target context for commands that need frame-aware behavior. */
	getTargetContext?: () => CdpTargetContext
	/** Resolve the selected target after recovery; rejects if a requested iframe is still not executable. */
	getReadyTargetContext?: () => Promise<CdpTargetContext>
}

type PendingRequest = {
	resolve: (result: unknown) => void
	reject: (error: Error) => void
	timer?: NodeJS.Timeout
}

type CdpConnection = {
	sendAndWait: (method: string, params?: Record<string, unknown>, options?: CdpSendOptions) => Promise<unknown>
	handleMessage: (data: unknown) => void
	close: (reason?: string) => void
}

let nextId = 1

export type CdpSessionController = {
	session: CdpSessionHandle
	attach: (socket: WebSocket) => CdpConnection
	detach: (reason?: string) => void
}

export const createCdpSessionHandle = (): CdpSessionController => {
	let connection: CdpConnection | null = null
	const handlers = new Map<string, Set<CdpEventHandler<never>>>()

	const session: CdpSessionHandle = {
		isAttached: () => Boolean(connection),
		sendAndWait: async (method, params, options) => {
			if (!connection) {
				throw createCdpNotAttachedError()
			}
			return connection.sendAndWait(method, params as Record<string, unknown> | undefined, options)
		},
		onEvent: (method, handler) => {
			let bucket = handlers.get(method)
			if (!bucket) {
				bucket = new Set()
				handlers.set(method, bucket)
			}
			bucket.add(handler as CdpEventHandler<never>)
			return () => {
				bucket?.delete(handler as CdpEventHandler<never>)
			}
		},
	}

	const attach = (socket: WebSocket): CdpConnection => {
		const pendingRequests = new Map<number, PendingRequest>()

		const sendAndWait = async (method: string, params?: Record<string, unknown>, options?: CdpSendOptions): Promise<unknown> => {
			const id = nextId++
			return new Promise((resolve, reject) => {
				const pending: PendingRequest = { resolve, reject }
				if (options?.timeoutMs) {
					pending.timer = setTimeout(() => {
						pendingRequests.delete(id)
						reject(new Error(`CDP request timed out after ${options.timeoutMs}ms`))
					}, options.timeoutMs)
				}
				pendingRequests.set(id, pending)
				try {
					socket.send(JSON.stringify({ id, method, params }))
				} catch (error) {
					pendingRequests.delete(id)
					if (pending.timer) {
						clearTimeout(pending.timer)
					}
					reject(error instanceof Error ? error : new Error(String(error)))
				}
			})
		}

		const handleMessage = (data: unknown): void => {
			const message = parseMessage(data)
			if (!message || typeof message !== 'object') {
				return
			}

			const payload = message as {
				id?: number
				result?: unknown
				error?: { message?: string } | null
				method?: string
				params?: unknown
			}

			if (payload.id != null) {
				const pending = pendingRequests.get(payload.id)
				if (!pending) {
					return
				}
				pendingRequests.delete(payload.id)
				if (pending.timer) {
					clearTimeout(pending.timer)
				}
				if (payload.error) {
					pending.reject(new Error(payload.error.message ?? 'CDP request failed'))
					return
				}
				pending.resolve(payload.result)
				return
			}

			if (payload.method) {
				const bucket = handlers.get(payload.method)
				if (!bucket || bucket.size === 0) {
					return
				}
				for (const handler of bucket) {
					try {
						// Dispatch is untyped by construction: the wire carries an arbitrary method
						// string, and the handler's payload type was checked at registration.
						;(handler as CdpEventHandler<CdpEvent>)(payload.params as CdpEventPayload<CdpEvent>, { sessionId: null })
					} catch {
						// Ignore handler errors to keep dispatch resilient.
					}
				}
			}
		}

		const close = (reason?: string): void => {
			for (const pending of pendingRequests.values()) {
				pending.reject(new Error(reason ?? 'CDP connection closed'))
				if (pending.timer) {
					clearTimeout(pending.timer)
				}
			}
			pendingRequests.clear()
		}

		const nextConnection: CdpConnection = {
			sendAndWait,
			handleMessage,
			close,
		}

		connection = nextConnection
		return nextConnection
	}

	const detach = (reason?: string): void => {
		if (connection) {
			connection.close(reason)
		}
		connection = null
	}

	return { session, attach, detach }
}

export const createCdpNotAttachedError = (): Error => createNotAttachedError('Watcher not attached to a CDP target')

const parseMessage = (data: unknown): unknown => {
	if (typeof data === 'string') {
		try {
			return JSON.parse(data)
		} catch {
			return null
		}
	}

	if (data instanceof ArrayBuffer) {
		return parseMessage(new TextDecoder().decode(data))
	}

	return null
}

/** A short-lived connection to one CDP endpoint, for commands that need no session. */
export type OneShotCdpConnection = {
	sendAndWait: <M extends CdpMethod>(method: M, params?: CdpParams<M>, options?: CdpSendOptions) => Promise<CdpResult<M>>
	close: () => void
}

/**
 * Open a CDP WebSocket and return a connection for issuing a few commands.
 *
 * `browserCookies.ts` used to carry a second, bespoke CDP-over-WebSocket transport
 * alongside this one — its own duck-typed WebSocket types, its own pending/timeout/cleanup
 * machinery, its own message parsing, and hardcoded per-call request ids that existed only
 * because it had no id allocator. Two transports in one directory meant every transport
 * fix had to be made twice.
 *
 * Callers must `close()`; nothing reconnects a one-shot connection.
 */
export const openCdpConnection = async (wsUrl: string, connectTimeoutMs = 5_000): Promise<OneShotCdpConnection> => {
	const WebSocketConstructor = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket
	if (!WebSocketConstructor) {
		throw new Error('WebSocket unavailable. Node 18+ required.')
	}

	const socket = new WebSocketConstructor(wsUrl)
	const controller = createCdpSessionHandle()
	const connection = controller.attach(socket)

	socket.addEventListener('message', (event) => {
		connection.handleMessage(event.data)
	})
	socket.addEventListener('close', () => {
		connection.close('socket_closed')
	})

	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`CDP connection timed out after ${connectTimeoutMs}ms`)), connectTimeoutMs)
		socket.addEventListener('open', () => {
			clearTimeout(timer)
			resolve()
		})
		socket.addEventListener('error', () => {
			clearTimeout(timer)
			reject(new Error('WebSocket error'))
		})
	})

	return {
		sendAndWait: controller.session.sendAndWait,
		close: () => {
			controller.detach('closed')
			try {
				socket.close()
			} catch {
				// Already closed; nothing to unwind.
			}
		},
	}
}
