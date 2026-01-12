export type CdpEventHandler = (params: unknown) => void

export type CdpSendOptions = {
	/** Optional timeout for this CDP command (ms). */
	timeoutMs?: number
}

export type CdpSessionHandle = {
	isAttached: () => boolean
	sendAndWait: (method: string, params?: Record<string, unknown>, options?: CdpSendOptions) => Promise<unknown>
	onEvent: (method: string, handler: CdpEventHandler) => () => void
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
	const handlers = new Map<string, Set<CdpEventHandler>>()

	const session: CdpSessionHandle = {
		isAttached: () => Boolean(connection),
		sendAndWait: async (method, params, options) => {
			if (!connection) {
				throw createCdpNotAttachedError()
			}
			return connection.sendAndWait(method, params, options)
		},
		onEvent: (method, handler) => {
			let bucket = handlers.get(method)
			if (!bucket) {
				bucket = new Set()
				handlers.set(method, bucket)
			}
			bucket.add(handler)
			return () => {
				bucket?.delete(handler)
			}
		},
	}

	const attach = (socket: WebSocket): CdpConnection => {
		const pendingRequests = new Map<number, PendingRequest>()

		const sendAndWait = async (
			method: string,
			params?: Record<string, unknown>,
			options?: CdpSendOptions,
		): Promise<unknown> => {
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
						handler(payload.params)
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

export const createCdpNotAttachedError = (): Error => {
	const error = new Error('Watcher not attached to a CDP target')
	;(error as Error & { code?: string }).code = 'cdp_not_attached'
	return error
}

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
