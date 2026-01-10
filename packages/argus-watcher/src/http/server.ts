import http from 'node:http'
import type { ErrorResponse, LogsResponse, StatusResponse, TailResponse, LogLevel, WatcherRecord } from 'argus-core'
import type { LogBuffer } from '../buffer/LogBuffer.js'

/** Options for the watcher HTTP server. */
export type HttpServerOptions = {
	host: string
	port: number
	buffer: LogBuffer
	getWatcher: () => WatcherRecord
	getCdpStatus: () => { attached: boolean; target: { title: string | null; url: string | null } | null }
}

/** Handle for the running HTTP server. */
export type HttpServerHandle = {
	port: number
	close: () => Promise<void>
}

/** Start HTTP server bound to localhost for watcher API. */
export const startHttpServer = async (options: HttpServerOptions): Promise<HttpServerHandle> => {
	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url ?? '/', `http://${req.headers.host ?? options.host}`)
		if (req.method === 'GET' && url.pathname === '/status') {
			return respondJson(res, buildStatus(options))
		}

		if (req.method === 'GET' && url.pathname === '/logs') {
			return handleLogs(url, res, options)
		}

		if (req.method === 'GET' && url.pathname === '/tail') {
			return handleTail(url, res, options)
		}

		respondJson(res, { ok: false, error: { message: 'Not found', code: 'not_found' } }, 404)
	})

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen(options.port, options.host, () => resolve())
	})

	const address = server.address()
	const port = typeof address === 'object' && address ? address.port : options.port

	return {
		port,
		close: () =>
			new Promise((resolve, reject) => {
				server.close((error) => {
					if (error) {
						reject(error)
						return
					}
					resolve()
				})
			})
	}
}

const handleLogs = (url: URL, res: http.ServerResponse, options: HttpServerOptions): void => {
	const after = clampNumber(url.searchParams.get('after'), 0)
	const limit = clampNumber(url.searchParams.get('limit'), 500, 1, 5000)
	const levels = parseLevels(url.searchParams.get('levels'))
	const grep = url.searchParams.get('grep') ?? undefined
	const sinceTs = clampNumber(url.searchParams.get('sinceTs'), undefined)

	const events = options.buffer.listAfter(after, { levels, grep, sinceTs }, limit)
	const nextAfter = events.length > 0 ? events[events.length - 1]?.id ?? after : after
	const response: LogsResponse = { ok: true, events, nextAfter }
	respondJson(res, response)
}

const handleTail = async (url: URL, res: http.ServerResponse, options: HttpServerOptions): Promise<void> => {
	const after = clampNumber(url.searchParams.get('after'), 0)
	const limit = clampNumber(url.searchParams.get('limit'), 500, 1, 5000)
	const timeoutMs = clampNumber(url.searchParams.get('timeoutMs'), 25_000, 1000, 120_000)
	const levels = parseLevels(url.searchParams.get('levels'))
	const grep = url.searchParams.get('grep') ?? undefined

	const events = await options.buffer.waitForAfter(after, { levels, grep }, limit, timeoutMs)
	const nextAfter = events.length > 0 ? events[events.length - 1]?.id ?? after : after
	const response: TailResponse = { ok: true, events, nextAfter, timedOut: events.length === 0 }
	respondJson(res, response)
}

const buildStatus = (options: HttpServerOptions): StatusResponse => {
	const watcher = options.getWatcher()
	const buffer = options.buffer.getStats()
	const cdpStatus = options.getCdpStatus()

	return {
		ok: true,
		id: watcher.id,
		pid: watcher.pid,
		attached: cdpStatus.attached,
		target: cdpStatus.target,
		buffer,
		watcher
	}
}

const respondJson = (res: http.ServerResponse, body: LogsResponse | TailResponse | StatusResponse | ErrorResponse, status = 200): void => {
	const payload = JSON.stringify(body)
	res.statusCode = status
	res.setHeader('Content-Type', 'application/json')
	res.end(payload)
}

const clampNumber = (value: string | null, fallback?: number, min?: number, max?: number): number => {
	if (value == null) {
		return fallback ?? 0
	}

	const parsed = Number(value)
	if (!Number.isFinite(parsed)) {
		return fallback ?? 0
	}

	if (min != null && parsed < min) {
		return min
	}

	if (max != null && parsed > max) {
		return max
	}

	return parsed
}

const parseLevels = (value: string | null): LogLevel[] | undefined => {
	if (!value) {
		return undefined
	}

	const levels = value
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean)

	if (levels.length === 0) {
		return undefined
	}

	return levels as LogLevel[]
}
