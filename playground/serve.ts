import * as http from 'node:http'
import * as fs from 'node:fs'
import * as path from 'node:path'

const PLAYGROUND_DIR = path.dirname(new URL(import.meta.url).pathname)

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
}

/** Start the playground HTTP server. Returns the server instance. */
export const startServer = (options: ServerOptions): http.Server => {
	const { port, crossOriginPort } = options

	const handler: http.RequestListener = (req, res) => {
		const url = req.url ?? '/'

		// Dynamic config script — exposes cross-origin port to the page
		if (url === '/config.js') {
			const script = crossOriginPort != null ? `window.__CROSS_ORIGIN_PORT = ${crossOriginPort};\n` : ''
			res.writeHead(200, {
				'Content-Type': 'text/javascript; charset=utf-8',
				'Content-Length': Buffer.byteLength(script),
			})
			res.end(script)
			return
		}

		const route = apiRoutes[url]
		if (route) {
			route(res)
			return
		}

		serveStatic(res, url)
	}

	const server = http.createServer(handler)
	server.listen(port, '127.0.0.1', () => {
		console.log(`Playground server listening on http://127.0.0.1:${port}`)
	})
	return server
}

// Standalone entry: npx tsx playground/serve.ts
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(PLAYGROUND_DIR, 'serve.ts')
if (isMain) {
	const port = Number(process.env['PLAYGROUND_PORT']) || 3333
	startServer({ port })
}
