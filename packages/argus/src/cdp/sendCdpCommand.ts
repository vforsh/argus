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
 * Send a single CDP command over a target/browser websocket and wait for the matching response.
 * This stays intentionally tiny so command modules can focus on selecting targets and formatting output.
 */
export const sendCdpCommand = async (wsUrl: string, payload: CdpCommandPayload, timeoutMs = 5_000): Promise<void> => {
	const WebSocketConstructor = getWebSocketCtor()
	if (!WebSocketConstructor) {
		throw new Error('WebSocket unavailable. Node 18+ required.')
	}

	const ws = new WebSocketConstructor(wsUrl)
	const requestId = payload.id

	await new Promise<void>((resolve, reject) => {
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

		const finish = (error?: Error) => {
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
			resolve()
		}

		const onOpen = () => {
			try {
				ws.send(JSON.stringify(payload))
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)))
			}
		}

		const onMessage = (event: { data?: unknown }) => {
			const text = toMessageText(event.data)
			if (!text) {
				return
			}

			try {
				const message = JSON.parse(text) as { id?: number; error?: { message?: string } }
				if (message.id !== requestId) {
					return
				}
				if (message.error?.message) {
					finish(new Error(message.error.message))
					return
				}
				finish()
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)))
			}
		}

		const onError = () => {
			finish(new Error('WebSocket error'))
		}

		const onClose = () => {
			finish(new Error('WebSocket closed before response'))
		}

		ws.addEventListener('open', onOpen)
		ws.addEventListener('message', onMessage)
		ws.addEventListener('error', onError)
		ws.addEventListener('close', onClose)
	})
}
