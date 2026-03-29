type WebSocketLike = {
	addEventListener: (event: 'open' | 'message' | 'error' | 'close', listener: (event: { data?: unknown }) => void) => void
	removeEventListener?: (event: 'open' | 'message' | 'error' | 'close', listener: (event: { data?: unknown }) => void) => void
	send: (data: string) => void
	close: () => void
}

type WebSocketCtor = new (url: string) => WebSocketLike

export type CdpCommandPayload = {
	id: number
	method: string
	params?: Record<string, unknown>
}

type CdpResponseMessage<T> = {
	id?: number
	result?: T
	error?: { message?: string }
}

const getWebSocketCtor = (): WebSocketCtor | null => {
	const ctor = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket
	return ctor ?? null
}

const toMessageText = (data: unknown): string | null => {
	if (typeof data === 'string') {
		return data
	}
	if (data instanceof ArrayBuffer) {
		return Buffer.from(data).toString('utf8')
	}
	if (Buffer.isBuffer(data)) {
		return data.toString('utf8')
	}
	return null
}

/**
 * Send a single CDP command over a target/browser websocket and return the raw `result` payload.
 */
export const sendCdpRequest = async <T>(wsUrl: string, payload: CdpCommandPayload, timeoutMs = 5_000): Promise<T> => {
	const WebSocketConstructor = getWebSocketCtor()
	if (!WebSocketConstructor) {
		throw new Error('WebSocket unavailable. Node 18+ required.')
	}

	const ws = new WebSocketConstructor(wsUrl)
	const requestId = payload.id

	return await new Promise<T>((resolve, reject) => {
		let settled = false
		const timer = setTimeout(() => {
			if (!settled) {
				settled = true
				try {
					ws.close()
				} catch {}
				reject(new Error(`CDP command timed out after ${timeoutMs}ms`))
			}
		}, timeoutMs)

		const cleanup = () => {
			clearTimeout(timer)
			ws.removeEventListener?.('open', onOpen)
			ws.removeEventListener?.('message', onMessage)
			ws.removeEventListener?.('error', onError)
			ws.removeEventListener?.('close', onClose)
		}

		const finish = (result?: T, error?: Error) => {
			if (settled) {
				return
			}
			settled = true
			cleanup()
			try {
				ws.close()
			} catch {}
			if (error) {
				reject(error)
				return
			}
			resolve(result as T)
		}

		const onOpen = () => {
			try {
				ws.send(JSON.stringify(payload))
			} catch (error) {
				finish(undefined, error instanceof Error ? error : new Error(String(error)))
			}
		}

		const onMessage = (event: { data?: unknown }) => {
			const text = toMessageText(event.data)
			if (!text) {
				return
			}

			try {
				const message = JSON.parse(text) as CdpResponseMessage<T>
				if (message.id !== requestId) {
					return
				}
				if (message.error?.message) {
					finish(undefined, new Error(message.error.message))
					return
				}
				finish(message.result as T)
			} catch (error) {
				finish(undefined, error instanceof Error ? error : new Error(String(error)))
			}
		}

		const onError = () => {
			finish(undefined, new Error('WebSocket error'))
		}

		const onClose = () => {
			finish(undefined, new Error('WebSocket closed before response'))
		}

		ws.addEventListener('open', onOpen)
		ws.addEventListener('message', onMessage)
		ws.addEventListener('error', onError)
		ws.addEventListener('close', onClose)
	})
}

/**
 * Send a single CDP command and ignore any successful result payload.
 * Keeps existing callsites terse while sharing the same request/response path.
 */
export const sendCdpCommand = async (wsUrl: string, payload: CdpCommandPayload, timeoutMs = 5_000): Promise<void> => {
	await sendCdpRequest(wsUrl, payload, timeoutMs)
}
