import http from 'node:http'
import type { ErrorResponse, LogsResponse, StatusResponse, TailResponse, LogLevel, WatcherRecord } from '@vforsh/argus-core'
import type { LogBuffer } from '../buffer/LogBuffer.js'

/** Optional metadata for the HTTP request event. */
export type HttpRequestEventMetadata = {
	endpoint: 'logs' | 'tail'
	remoteAddress: string | null
	query: {
		after?: number
		limit?: number
		levels?: LogLevel[]
		match?: string[]
		matchCase?: 'sensitive' | 'insensitive'
		source?: string
		sinceTs?: number
		timeoutMs?: number
	}
	ts: number
}

/** Options for the watcher HTTP server. */
export type HttpServerOptions = {
	host: string
	port: number
	buffer: LogBuffer
	getWatcher: () => WatcherRecord
	getCdpStatus: () => { attached: boolean; target: { title: string | null; url: string | null } | null }
	/** Optional callback invoked when logs or tail are requested. */
	onRequest?: (event: HttpRequestEventMetadata) => void
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
			}),
	}
}

const handleLogs = (url: URL, res: http.ServerResponse, options: HttpServerOptions): void => {
	const after = clampNumber(url.searchParams.get('after'), 0)
	const limit = clampNumber(url.searchParams.get('limit'), 500, 1, 5000)
	const levels = parseLevels(url.searchParams.get('levels'))
	const match = url.searchParams.getAll('match')
	const matchCase = resolveMatchCase(url.searchParams.get('matchCase'))
	if (!matchCase) {
		return respondInvalidMatchCase(res)
	}
	const source = normalizeQueryValue(url.searchParams.get('source'))
	const sinceTs = clampNumber(url.searchParams.get('sinceTs'), undefined)

	const matchPatterns = normalizeMatchPatterns(match)
	if (matchPatterns.error) {
		return respondInvalidMatch(res, matchPatterns.error)
	}
	const compiledMatch = compileMatchPatterns(matchPatterns.patterns, matchCase)
	if (compiledMatch.error) {
		return respondInvalidMatch(res, compiledMatch.error)
	}

	options.onRequest?.({
		endpoint: 'logs',
		remoteAddress: res.req.socket.remoteAddress ?? null,
		query: { after, limit, levels, match: matchPatterns.patterns, matchCase, source, sinceTs },
		ts: Date.now(),
	})

	const events = options.buffer.listAfter(after, { levels, match: compiledMatch.match, source, sinceTs }, limit)
	const nextAfter = events.length > 0 ? (events[events.length - 1]?.id ?? after) : after
	const response: LogsResponse = { ok: true, events, nextAfter }
	respondJson(res, response)
}

const handleTail = async (url: URL, res: http.ServerResponse, options: HttpServerOptions): Promise<void> => {
	const after = clampNumber(url.searchParams.get('after'), 0)
	const limit = clampNumber(url.searchParams.get('limit'), 500, 1, 5000)
	const timeoutMs = clampNumber(url.searchParams.get('timeoutMs'), 25_000, 1000, 120_000)
	const levels = parseLevels(url.searchParams.get('levels'))
	const match = url.searchParams.getAll('match')
	const matchCase = resolveMatchCase(url.searchParams.get('matchCase'))
	if (!matchCase) {
		return respondInvalidMatchCase(res)
	}
	const source = normalizeQueryValue(url.searchParams.get('source'))

	const matchPatterns = normalizeMatchPatterns(match)
	if (matchPatterns.error) {
		return respondInvalidMatch(res, matchPatterns.error)
	}
	const compiledMatch = compileMatchPatterns(matchPatterns.patterns, matchCase)
	if (compiledMatch.error) {
		return respondInvalidMatch(res, compiledMatch.error)
	}

	options.onRequest?.({
		endpoint: 'tail',
		remoteAddress: res.req.socket.remoteAddress ?? null,
		query: { after, limit, levels, match: matchPatterns.patterns, matchCase, source, timeoutMs },
		ts: Date.now(),
	})

	const events = await options.buffer.waitForAfter(after, { levels, match: compiledMatch.match, source }, limit, timeoutMs)
	const nextAfter = events.length > 0 ? (events[events.length - 1]?.id ?? after) : after
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
		watcher,
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

const resolveMatchCase = (value: string | null): 'sensitive' | 'insensitive' | null => {
	if (!value) {
		return 'insensitive'
	}

	if (value === 'sensitive' || value === 'insensitive') {
		return value
	}

	return null
}

const normalizeMatchPatterns = (
	match: string[],
): { patterns: string[]; error?: string } => {
	const patterns: string[] = []
	for (const pattern of match) {
		const trimmed = pattern.trim()
		if (!trimmed) {
			return { patterns: [], error: 'Invalid match pattern "(empty)"' }
		}
		patterns.push(trimmed)
	}

	return { patterns }
}

const compileMatchPatterns = (
	patterns: string[],
	matchCase: 'sensitive' | 'insensitive',
): { match?: RegExp[]; error?: string } => {
	if (patterns.length === 0) {
		return {}
	}

	const flags = matchCase === 'sensitive' ? '' : 'i'
	const compiled: RegExp[] = []

	for (const pattern of patterns) {
		try {
			compiled.push(new RegExp(pattern, flags))
		} catch (error) {
			return { error: `Invalid match pattern "${pattern}": ${formatError(error)}` }
		}
	}

	return { match: compiled }
}

const respondInvalidMatch = (res: http.ServerResponse, message: string): void => {
	respondJson(res, { ok: false, error: { message, code: 'invalid_match' } }, 400)
}

const respondInvalidMatchCase = (res: http.ServerResponse): void => {
	respondJson(res, { ok: false, error: { message: 'Invalid matchCase value', code: 'invalid_match_case' } }, 400)
}

const normalizeQueryValue = (value: string | null): string | undefined => {
	if (value == null) {
		return undefined
	}

	const trimmed = value.trim()
	if (!trimmed) {
		return undefined
	}

	return trimmed
}

const formatError = (error: unknown): string => {
	if (!error) {
		return 'unknown error'
	}
	if (error instanceof Error) {
		return error.message
	}
	return String(error)
}
