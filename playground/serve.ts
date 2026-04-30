import * as http from 'node:http'
import * as fs from 'node:fs'
import * as path from 'node:path'
import crypto from 'node:crypto'
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net'

const PLAYGROUND_DIR = import.meta.dirname!

const MIME_TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
}

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
	const payload = JSON.stringify(body)
	res.writeHead(status, {
		'Content-Type': 'application/json; charset=utf-8',
		'Content-Length': Buffer.byteLength(payload),
	})
	res.end(payload)
}

const serveStatic = (res: http.ServerResponse, urlPath: string): void => {
	const filePath = path.join(PLAYGROUND_DIR, urlPath === '/' ? 'index.html' : urlPath)
	const ext = path.extname(filePath)
	const contentType = MIME_TYPES[ext] ?? 'application/octet-stream'

	let data: Buffer
	try {
		data = fs.readFileSync(filePath)
	} catch {
		res.writeHead(404, { 'Content-Type': 'text/plain' })
		res.end('Not found')
		return
	}

	res.writeHead(200, {
		'Content-Type': contentType,
		'Content-Length': data.length,
	})
	res.end(data)
}

const startSse = (res: http.ServerResponse): void => {
	res.writeHead(200, {
		'Content-Type': 'text/event-stream; charset=utf-8',
		'Cache-Control': 'no-cache',
		Connection: 'keep-alive',
		'X-Accel-Buffering': 'no',
	})

	let count = 0
	const send = (): void => {
		count += 1
		res.write(`id: ${count}\n`)
		res.write('event: playground\n')
		res.write(`data: ${JSON.stringify({ count, ts: Date.now() })}\n\n`)
	}

	send()
	const timer = setInterval(send, 1000)
	res.on('close', () => {
		clearInterval(timer)
	})
}

const apiRoutes: Record<string, (res: http.ServerResponse) => void> = {
	'/api/echo': (res) => {
		json(res, 200, { ok: true, message: 'echo', ts: Date.now() })
	},
	'/api/slow': (res) => {
		setTimeout(() => {
			json(res, 200, { ok: true, message: 'slow (2s)', ts: Date.now() })
		}, 2000)
	},
	'/api/error': (res) => {
		json(res, 500, { ok: false, error: 'Intentional server error' })
	},
}

export type ServerOptions = {
	port: number
	/** Port of the cross-origin server, exposed to the page via /config.js. */
	crossOriginPort?: number
	/** Port of the playground WebSocket server, exposed to the page via /config.js. */
	webSocketPort?: number
}

/** Start the playground HTTP server. Returns the server instance. */
export const startServer = (options: ServerOptions): http.Server => {
	const { port, crossOriginPort, webSocketPort } = options

	const handler: http.RequestListener = (req, res) => {
		const url = req.url ?? '/'
		const pathname = new URL(url, `http://${req.headers.host ?? '127.0.0.1'}`).pathname

		// Dynamic config script — exposes cross-origin port to the page
		if (pathname === '/config.js') {
			const script = [
				crossOriginPort != null ? `window.__CROSS_ORIGIN_PORT = ${crossOriginPort};` : '',
				webSocketPort != null ? `window.__WS_PORT = ${webSocketPort};` : '',
			]
				.filter(Boolean)
				.join('\n')
			res.writeHead(200, {
				'Content-Type': 'text/javascript; charset=utf-8',
				'Content-Length': Buffer.byteLength(script),
			})
			res.end(script)
			return
		}

		const route = apiRoutes[pathname]
		if (route) {
			route(res)
			return
		}

		if (pathname === '/events') {
			startSse(res)
			return
		}

		serveStatic(res, pathname)
	}

	const server = http.createServer(handler)
	server.listen(port, '127.0.0.1', () => {
		console.log(`Playground server listening on http://127.0.0.1:${port}`)
	})
	return server
}

/** Start a tiny WebSocket echo server used by the playground realtime panel. */
export const startWebSocketServer = (port: number): TcpServer => {
	const server = createTcpServer((socket) => {
		let upgraded = false
		socket.on('data', (chunk) => {
			if (!upgraded) {
				upgraded = handleWebSocketUpgrade(chunk, socket)
				return
			}
			for (const message of decodeWebSocketTextFrames(chunk)) {
				socket.write(encodeWebSocketTextFrame(`echo:${message}`))
			}
		})
	})
	server.listen(port, '127.0.0.1', () => {
		console.log(`Playground WebSocket server listening on ws://127.0.0.1:${port}/ws/echo`)
	})
	return server
}

const handleWebSocketUpgrade = (chunk: Buffer, socket: Socket): boolean => {
	const request = chunk.toString('utf8')
	const [head, rest = ''] = request.split('\r\n\r\n')
	const lines = head?.split('\r\n') ?? []
	const requestLine = lines[0] ?? ''
	if (!requestLine.startsWith('GET /ws/echo')) {
		socket.destroy()
		return false
	}

	const headers = new Map<string, string>()
	for (const line of lines.slice(1)) {
		const separator = line.indexOf(':')
		if (separator === -1) continue
		headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim())
	}
	const key = headers.get('sec-websocket-key')
	if (!key) {
		socket.destroy()
		return false
	}

	const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
	socket.write(
		['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '\r\n'].join('\r\n'),
	)

	const remaining = Buffer.from(rest, 'binary')
	if (remaining.length > 0) {
		for (const message of decodeWebSocketTextFrames(remaining)) {
			socket.write(encodeWebSocketTextFrame(`echo:${message}`))
		}
	}
	return true
}

const decodeWebSocketTextFrames = (buffer: Buffer): string[] => {
	const messages: string[] = []
	let offset = 0

	while (offset + 2 <= buffer.length) {
		const first = buffer[offset]!
		const second = buffer[offset + 1]!
		const opcode = first & 0x0f
		const masked = (second & 0x80) !== 0
		let length = second & 0x7f
		offset += 2

		if (length === 126) {
			if (offset + 2 > buffer.length) break
			length = buffer.readUInt16BE(offset)
			offset += 2
		} else if (length === 127) {
			if (offset + 8 > buffer.length) break
			const largeLength = Number(buffer.readBigUInt64BE(offset))
			if (!Number.isSafeInteger(largeLength)) break
			length = largeLength
			offset += 8
		}

		const mask = masked ? buffer.subarray(offset, offset + 4) : null
		if (masked) {
			offset += 4
		}
		if (offset + length > buffer.length) break

		const payload = Buffer.from(buffer.subarray(offset, offset + length))
		offset += length

		if (mask) {
			for (let index = 0; index < payload.length; index += 1) {
				payload[index] = payload[index]! ^ mask[index % 4]!
			}
		}

		if (opcode === 0x1) {
			messages.push(payload.toString('utf8'))
		}
	}

	return messages
}

const encodeWebSocketTextFrame = (message: string): Buffer => {
	const payload = Buffer.from(message)
	if (payload.length < 126) {
		return Buffer.concat([Buffer.from([0x81, payload.length]), payload])
	}

	const header = Buffer.alloc(4)
	header[0] = 0x81
	header[1] = 126
	header.writeUInt16BE(payload.length, 2)
	return Buffer.concat([header, payload])
}

// Standalone entry: bun playground/serve.ts
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(PLAYGROUND_DIR, 'serve.ts')
if (isMain) {
	const port = Number(process.env['PLAYGROUND_PORT']) || 3333
	startServer({ port })
}
