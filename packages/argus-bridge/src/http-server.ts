/**
 * HTTP server for the bridge, exposing watcher-compatible API.
 * Provides /targets and /attach endpoints in addition to standard watcher endpoints.
 */

import http from 'node:http'
import type { SessionManager, ExtensionSession } from './session-manager.js'
import type { TabInfo } from './types.js'
import type {
	LogsResponse,
	StatusResponse,
	TailResponse,
	LogLevel,
	WatcherRecord,
	EvalRequest,
	EvalResponse,
	ScreenshotRequest,
	ScreenshotResponse,
} from '@vforsh/argus-core'
import type { LogBuffer } from './log-buffer.js'

/** Options for the bridge HTTP server. */
export type HttpServerOptions = {
	host: string
	port: number
	buffer: LogBuffer
	sessionManager: SessionManager
	getBridgeRecord: () => BridgeRecord
	onRequest?: (event: HttpRequestEventMetadata) => void
	onShutdown?: () => void | Promise<void>
}

export type BridgeRecord = {
	id: string
	host: string
	port: number
	pid: number
	cwd: string
	startedAt: number
	updatedAt: number
	source: 'extension'
}

export type HttpRequestEventMetadata = {
	endpoint: string
	remoteAddress: string | null
	ts: number
}

export type HttpServerHandle = {
	port: number
	close: () => Promise<void>
}

/**
 * Start HTTP server for the bridge API.
 */
export const startHttpServer = async (options: HttpServerOptions): Promise<HttpServerHandle> => {
	const server = http.createServer(async (req, res) => {
		// Add CORS headers for local development
		res.setHeader('Access-Control-Allow-Origin', '*')
		res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

		if (req.method === 'OPTIONS') {
			res.statusCode = 204
			res.end()
			return
		}

		const url = new URL(req.url ?? '/', `http://${req.headers.host ?? options.host}`)

		try {
			// Bridge-specific endpoints
			if (req.method === 'GET' && url.pathname === '/status') {
				return handleStatus(res, options)
			}

			if (req.method === 'GET' && url.pathname === '/targets') {
				return await handleTargets(res, options)
			}

			if (req.method === 'POST' && url.pathname === '/attach') {
				return await handleAttach(req, res, options)
			}

			if (req.method === 'POST' && url.pathname === '/detach') {
				return await handleDetach(req, res, options)
			}

			// Standard watcher endpoints
			if (req.method === 'GET' && url.pathname === '/logs') {
				return handleLogs(url, res, options)
			}

			if (req.method === 'GET' && url.pathname === '/tail') {
				return await handleTail(url, res, options)
			}

			if (req.method === 'POST' && url.pathname === '/eval') {
				return await handleEval(req, res, options)
			}

			if (req.method === 'POST' && url.pathname === '/screenshot') {
				return await handleScreenshot(req, res, options)
			}

			if (req.method === 'POST' && url.pathname === '/shutdown') {
				return handleShutdown(res, options)
			}

			respondJson(res, { ok: false, error: { message: 'Not found', code: 'not_found' } }, 404)
		} catch (error) {
			respondError(res, error)
		}
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

// ============================================================
// Bridge-specific handlers
// ============================================================

const handleStatus = (res: http.ServerResponse, options: HttpServerOptions): void => {
	const record = options.getBridgeRecord()
	const sessions = options.sessionManager.listSessions()
	const bufferStats = options.buffer.getStats()

	const response: StatusResponse & { sessions: SessionInfo[] } = {
		ok: true,
		id: record.id,
		pid: record.pid,
		attached: sessions.length > 0,
		target: sessions.length > 0 ? { title: sessions[0].title, url: sessions[0].url } : null,
		buffer: bufferStats,
		watcher: record as unknown as WatcherRecord,
		sessions: sessions.map((s) => ({
			tabId: s.tabId,
			url: s.url,
			title: s.title,
			attachedAt: s.attachedAt,
		})),
	}

	respondJson(res, response)
}

type SessionInfo = {
	tabId: number
	url: string
	title: string
	attachedAt: number
}

const handleTargets = async (res: http.ServerResponse, options: HttpServerOptions): Promise<void> => {
	try {
		const tabs = await options.sessionManager.listTabs()
		respondJson(res, { ok: true, targets: tabs })
	} catch (error) {
		respondError(res, error)
	}
}

const handleAttach = async (req: http.IncomingMessage, res: http.ServerResponse, options: HttpServerOptions): Promise<void> => {
	const payload = await readJsonBody<{ tabId: number }>(req, res)
	if (!payload) {
		return
	}

	if (typeof payload.tabId !== 'number') {
		return respondInvalidBody(res, 'tabId is required')
	}

	options.onRequest?.({
		endpoint: 'attach',
		remoteAddress: res.req.socket.remoteAddress ?? null,
		ts: Date.now(),
	})

	options.sessionManager.attachTab(payload.tabId)
	respondJson(res, { ok: true, message: 'Attach request sent' })
}

const handleDetach = async (req: http.IncomingMessage, res: http.ServerResponse, options: HttpServerOptions): Promise<void> => {
	const payload = await readJsonBody<{ tabId: number }>(req, res)
	if (!payload) {
		return
	}

	if (typeof payload.tabId !== 'number') {
		return respondInvalidBody(res, 'tabId is required')
	}

	options.onRequest?.({
		endpoint: 'detach',
		remoteAddress: res.req.socket.remoteAddress ?? null,
		ts: Date.now(),
	})

	options.sessionManager.detachTab(payload.tabId)
	respondJson(res, { ok: true, message: 'Detach request sent' })
}

// ============================================================
// Standard watcher handlers
// ============================================================

const handleLogs = (url: URL, res: http.ServerResponse, options: HttpServerOptions): void => {
	const after = clampNumber(url.searchParams.get('after'), 0)
	const limit = clampNumber(url.searchParams.get('limit'), 500, 1, 5000)
	const levels = parseLevels(url.searchParams.get('levels'))
	const sinceTs = clampNumber(url.searchParams.get('sinceTs'), undefined)

	options.onRequest?.({
		endpoint: 'logs',
		remoteAddress: res.req.socket.remoteAddress ?? null,
		ts: Date.now(),
	})

	const events = options.buffer.listAfter(after, { levels, sinceTs }, limit)
	const nextAfter = events.length > 0 ? (events[events.length - 1]?.id ?? after) : after
	const response: LogsResponse = { ok: true, events, nextAfter }
	respondJson(res, response)
}

const handleTail = async (url: URL, res: http.ServerResponse, options: HttpServerOptions): Promise<void> => {
	const after = clampNumber(url.searchParams.get('after'), 0)
	const limit = clampNumber(url.searchParams.get('limit'), 500, 1, 5000)
	const timeoutMs = clampNumber(url.searchParams.get('timeoutMs'), 25_000, 1000, 120_000)
	const levels = parseLevels(url.searchParams.get('levels'))

	options.onRequest?.({
		endpoint: 'tail',
		remoteAddress: res.req.socket.remoteAddress ?? null,
		ts: Date.now(),
	})

	const events = await options.buffer.waitForAfter(after, { levels }, limit, timeoutMs)
	const nextAfter = events.length > 0 ? (events[events.length - 1]?.id ?? after) : after
	const response: TailResponse = { ok: true, events, nextAfter, timedOut: events.length === 0 }
	respondJson(res, response)
}

const handleEval = async (req: http.IncomingMessage, res: http.ServerResponse, options: HttpServerOptions): Promise<void> => {
	const payload = await readJsonBody<EvalRequest & { tabId?: number }>(req, res)
	if (!payload) {
		return
	}

	if (!payload.expression || typeof payload.expression !== 'string') {
		return respondInvalidBody(res, 'expression is required')
	}

	options.onRequest?.({
		endpoint: 'eval',
		remoteAddress: res.req.socket.remoteAddress ?? null,
		ts: Date.now(),
	})

	// Find the session to use
	let session: ExtensionSession | undefined
	if (payload.tabId !== undefined) {
		session = options.sessionManager.getSession(payload.tabId)
		if (!session) {
			return respondJson(
				res,
				{
					ok: false,
					error: { message: `Tab ${payload.tabId} is not attached`, code: 'cdp_not_attached' },
				},
				400,
			)
		}
	} else {
		session = options.sessionManager.getFirstSession()
		if (!session) {
			return respondJson(
				res,
				{
					ok: false,
					error: { message: 'No tabs attached', code: 'cdp_not_attached' },
				},
				400,
			)
		}
	}

	try {
		const awaitPromise = payload.awaitPromise !== false
		const returnByValue = payload.returnByValue !== false
		const timeoutMs = typeof payload.timeoutMs === 'number' ? payload.timeoutMs : undefined

		const result = await session.handle.sendAndWait(
			'Runtime.evaluate',
			{
				expression: payload.expression,
				awaitPromise,
				returnByValue,
			},
			{ timeoutMs },
		)

		const evalResult = result as {
			result?: { value?: unknown; type?: string; description?: string }
			exceptionDetails?: { text?: string; exception?: { description?: string } }
		}

		if (evalResult.exceptionDetails) {
			const exception = evalResult.exceptionDetails
			const message = exception.exception?.description ?? exception.text ?? 'Evaluation failed'
			const response: EvalResponse = {
				ok: true,
				result: null,
				type: null,
				exception: { text: message },
			}
			return respondJson(res, response)
		}

		const response: EvalResponse = {
			ok: true,
			result: evalResult.result?.value,
			type: evalResult.result?.type ?? null,
			exception: null,
		}
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}

const handleScreenshot = async (req: http.IncomingMessage, res: http.ServerResponse, options: HttpServerOptions): Promise<void> => {
	const payload = await readJsonBody<ScreenshotRequest & { tabId?: number }>(req, res)
	if (!payload) {
		return
	}

	options.onRequest?.({
		endpoint: 'screenshot',
		remoteAddress: res.req.socket.remoteAddress ?? null,
		ts: Date.now(),
	})

	// Find the session to use
	let session: ExtensionSession | undefined
	if (payload.tabId !== undefined) {
		session = options.sessionManager.getSession(payload.tabId)
		if (!session) {
			return respondJson(
				res,
				{
					ok: false,
					error: { message: `Tab ${payload.tabId} is not attached`, code: 'cdp_not_attached' },
				},
				400,
			)
		}
	} else {
		session = options.sessionManager.getFirstSession()
		if (!session) {
			return respondJson(
				res,
				{
					ok: false,
					error: { message: 'No tabs attached', code: 'cdp_not_attached' },
				},
				400,
			)
		}
	}

	try {
		const format = payload.format ?? 'png'
		if (format !== 'png') {
			return respondJson(
				res,
				{
					ok: false,
					error: { message: `Unsupported screenshot format: ${format}`, code: 'invalid_request' },
				},
				400,
			)
		}

		let clip: ScreenshotClip | undefined

		// If selector is provided, calculate clip region
		if (payload.selector) {
			clip = await resolveClip(session, payload.selector)
		}

		// Capture screenshot via CDP
		const result = await session.handle.sendAndWait('Page.captureScreenshot', {
			format,
			clip,
		})

		const response = result as { data?: string }
		if (!response.data) {
			return respondJson(
				res,
				{
					ok: false,
					error: { message: 'Failed to capture screenshot', code: 'cdp_error' },
				},
				500,
			)
		}

		// Return base64 data directly (bridge doesn't have filesystem access like watcher)
		respondJson(res, {
			ok: true,
			data: response.data,
			format,
			clipped: Boolean(clip),
		})
	} catch (error) {
		respondError(res, error)
	}
}

type ScreenshotClip = { x: number; y: number; width: number; height: number; scale: number }

const resolveClip = async (session: ExtensionSession, selector: string): Promise<ScreenshotClip> => {
	await session.handle.sendAndWait('DOM.enable')

	const documentResult = await session.handle.sendAndWait('DOM.getDocument', { depth: 1 })
	const root = documentResult as { root?: { nodeId?: number } }
	const rootId = root.root?.nodeId
	if (!rootId) {
		throw new Error('Unable to resolve DOM root')
	}

	const queryResult = await session.handle.sendAndWait('DOM.querySelector', { nodeId: rootId, selector })
	const nodeId = (queryResult as { nodeId?: number }).nodeId
	if (!nodeId) {
		throw new Error(`No element found for selector: ${selector}`)
	}

	const boxResult = await session.handle.sendAndWait('DOM.getBoxModel', { nodeId })
	const quad =
		(boxResult as { model?: { content?: number[]; border?: number[] } }).model?.content ??
		(boxResult as { model?: { border?: number[] } }).model?.border

	if (!quad || quad.length < 8) {
		throw new Error('Unable to compute element box model')
	}

	const rect = quadToRect(quad)
	if (rect.width <= 0 || rect.height <= 0) {
		throw new Error('Element has zero area')
	}

	const metrics = await session.handle.sendAndWait('Page.getLayoutMetrics')
	const viewport = (metrics as { visualViewport?: { pageX?: number; pageY?: number; scale?: number } }).visualViewport
	const pageX = viewport?.pageX ?? 0
	const pageY = viewport?.pageY ?? 0
	const scale = viewport?.scale ?? 1

	return {
		x: rect.x - pageX,
		y: rect.y - pageY,
		width: rect.width,
		height: rect.height,
		scale,
	}
}

const quadToRect = (quad: number[]): { x: number; y: number; width: number; height: number } => {
	const xs = [quad[0], quad[2], quad[4], quad[6]]
	const ys = [quad[1], quad[3], quad[5], quad[7]]
	const minX = Math.min(...xs)
	const maxX = Math.max(...xs)
	const minY = Math.min(...ys)
	const maxY = Math.max(...ys)

	return {
		x: minX,
		y: minY,
		width: maxX - minX,
		height: maxY - minY,
	}
}

const handleShutdown = (res: http.ServerResponse, options: HttpServerOptions): void => {
	options.onRequest?.({
		endpoint: 'shutdown',
		remoteAddress: res.req.socket.remoteAddress ?? null,
		ts: Date.now(),
	})

	respondJson(res, { ok: true })

	if (options.onShutdown) {
		queueMicrotask(() => {
			void options.onShutdown?.()
		})
	}
}

// ============================================================
// HTTP Utilities
// ============================================================

const respondJson = <T extends object>(res: http.ServerResponse, body: T, status = 200): void => {
	const payload = JSON.stringify(body)
	res.statusCode = status
	res.setHeader('Content-Type', 'application/json')
	res.end(payload)
}

const respondInvalidBody = (res: http.ServerResponse, message: string): void => {
	respondJson(res, { ok: false, error: { message, code: 'invalid_request' } }, 400)
}

const respondError = (res: http.ServerResponse, error: unknown): void => {
	const message = error instanceof Error ? error.message : String(error)
	const code = (error as { code?: string })?.code
	respondJson(res, { ok: false, error: { message, code } }, 500)
}

const readJsonBody = async <T>(req: http.IncomingMessage, res: http.ServerResponse): Promise<T | null> => {
	const chunks: Buffer[] = []
	let size = 0
	const maxBytes = 1_000_000

	try {
		for await (const chunk of req) {
			size += chunk.length
			if (size > maxBytes) {
				respondJson(res, { ok: false, error: { message: 'Request body too large', code: 'payload_too_large' } }, 413)
				return null
			}
			chunks.push(Buffer.from(chunk))
		}
	} catch {
		respondJson(res, { ok: false, error: { message: 'Invalid request body', code: 'invalid_json' } }, 400)
		return null
	}

	if (chunks.length === 0) {
		return {} as T
	}

	const raw = Buffer.concat(chunks).toString('utf8')
	if (!raw.trim()) {
		return {} as T
	}

	try {
		return JSON.parse(raw) as T
	} catch {
		respondJson(res, { ok: false, error: { message: 'Invalid JSON body', code: 'invalid_json' } }, 400)
		return null
	}
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
