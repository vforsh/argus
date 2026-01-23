import http from 'node:http'
import type {
	LogsResponse,
	StatusResponse,
	TailResponse,
	LogLevel,
	WatcherRecord,
	NetResponse,
	NetTailResponse,
	EvalRequest,
	EvalResponse,
	TraceStartRequest,
	TraceStartResponse,
	TraceStopRequest,
	TraceStopResponse,
	ScreenshotRequest,
	ScreenshotResponse,
	DomTreeRequest,
	DomTreeResponse,
	DomInfoRequest,
	DomInfoResponse,
	DomHoverRequest,
	DomHoverResponse,
	DomClickRequest,
	DomClickResponse,
	StorageLocalRequest,
	ShutdownResponse,
} from '@vforsh/argus-core'
import type { LogBuffer } from '../buffer/LogBuffer.js'
import type { NetBuffer } from '../buffer/NetBuffer.js'
import type { CdpSessionHandle } from '../cdp/connection.js'
import type { TraceRecorder } from '../cdp/tracing.js'
import type { Screenshotter } from '../cdp/screenshot.js'
import { evaluateExpression } from '../cdp/eval.js'
import { fetchDomSubtreeBySelector, fetchDomInfoBySelector } from '../cdp/dom.js'
import { resolveDomSelectorMatches, hoverDomNodes, clickDomNodes } from '../cdp/mouse.js'
import { executeStorageLocal } from '../cdp/storageLocal.js'
import {
	respondJson,
	respondInvalidMatch,
	respondInvalidMatchCase,
	respondInvalidBody,
	respondError,
	readJsonBody,
	clampNumber,
	parseLevels,
	resolveMatchCase,
	normalizeMatchPatterns,
	compileMatchPatterns,
	normalizeQueryValue,
	normalizeBoolean,
	normalizeTimeout,
} from './httpUtils.js'

/** Optional metadata for the HTTP request event. */
export type HttpRequestEventMetadata = {
	endpoint:
		| 'logs'
		| 'tail'
		| 'net'
		| 'net/tail'
		| 'eval'
		| 'trace/start'
		| 'trace/stop'
		| 'screenshot'
		| 'dom/tree'
		| 'dom/info'
		| 'dom/hover'
		| 'dom/click'
		| 'storage/local'
		| 'shutdown'
	remoteAddress: string | null
	query?: {
		after?: number
		limit?: number
		levels?: LogLevel[]
		match?: string[]
		matchCase?: 'sensitive' | 'insensitive'
		source?: string
		sinceTs?: number
		timeoutMs?: number
		grep?: string
	}
	ts: number
}

/** Options for the watcher HTTP server. */
export type HttpServerOptions = {
	host: string
	port: number
	buffer: LogBuffer
	/** Network buffer for /net endpoints. Null when net capture is disabled. */
	netBuffer: NetBuffer | null
	getWatcher: () => WatcherRecord
	getCdpStatus: () => { attached: boolean; target: { title: string | null; url: string | null } | null }
	cdpSession: CdpSessionHandle
	traceRecorder: TraceRecorder
	screenshotter: Screenshotter
	/** Optional callback invoked when logs or tail are requested. */
	onRequest?: (event: HttpRequestEventMetadata) => void
	/** Optional callback invoked when a shutdown request is received. */
	onShutdown?: () => void | Promise<void>
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

		if (req.method === 'GET' && url.pathname === '/net') {
			return handleNet(url, res, options)
		}

		if (req.method === 'GET' && url.pathname === '/net/tail') {
			return handleNetTail(url, res, options)
		}

		if (req.method === 'POST' && url.pathname === '/eval') {
			return handleEval(req, res, options)
		}

		if (req.method === 'POST' && url.pathname === '/trace/start') {
			return handleTraceStart(req, res, options)
		}

		if (req.method === 'POST' && url.pathname === '/trace/stop') {
			return handleTraceStop(req, res, options)
		}

		if (req.method === 'POST' && url.pathname === '/screenshot') {
			return handleScreenshot(req, res, options)
		}

		if (req.method === 'POST' && url.pathname === '/dom/tree') {
			return handleDomTree(req, res, options)
		}

		if (req.method === 'POST' && url.pathname === '/dom/info') {
			return handleDomInfo(req, res, options)
		}

		if (req.method === 'POST' && url.pathname === '/dom/hover') {
			return handleDomHover(req, res, options)
		}

		if (req.method === 'POST' && url.pathname === '/dom/click') {
			return handleDomClick(req, res, options)
		}

		if (req.method === 'POST' && url.pathname === '/storage/local') {
			return handleStorageLocal(req, res, options)
		}

		if (req.method === 'POST' && url.pathname === '/shutdown') {
			return handleShutdown(res, options)
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

const handleShutdown = (res: http.ServerResponse, options: HttpServerOptions): void => {
	options.onRequest?.({
		endpoint: 'shutdown',
		remoteAddress: res.req.socket.remoteAddress ?? null,
		ts: Date.now(),
	})

	const response: ShutdownResponse = { ok: true }
	respondJson(res, response)

	if (options.onShutdown) {
		queueMicrotask(() => {
			void options.onShutdown?.()
		})
	}
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

const handleNet = (url: URL, res: http.ServerResponse, options: HttpServerOptions): void => {
	if (!options.netBuffer) {
		return respondJson(res, { ok: false, error: { code: 'net_disabled', message: 'Network capture is disabled for this watcher' } }, 400)
	}

	const after = clampNumber(url.searchParams.get('after'), 0)
	const limit = clampNumber(url.searchParams.get('limit'), 500, 1, 5000)
	const sinceTs = clampNumber(url.searchParams.get('sinceTs'), undefined)
	const grep = normalizeQueryValue(url.searchParams.get('grep'))

	options.onRequest?.({
		endpoint: 'net',
		remoteAddress: res.req.socket.remoteAddress ?? null,
		query: { after, limit, sinceTs, grep },
		ts: Date.now(),
	})

	const requests = options.netBuffer.listAfter(after, { sinceTs, grep }, limit)
	const nextAfter = requests.length > 0 ? (requests[requests.length - 1]?.id ?? after) : after
	const response: NetResponse = { ok: true, requests, nextAfter }
	respondJson(res, response)
}

const handleNetTail = async (url: URL, res: http.ServerResponse, options: HttpServerOptions): Promise<void> => {
	if (!options.netBuffer) {
		return respondJson(res, { ok: false, error: { code: 'net_disabled', message: 'Network capture is disabled for this watcher' } }, 400)
	}

	const after = clampNumber(url.searchParams.get('after'), 0)
	const limit = clampNumber(url.searchParams.get('limit'), 500, 1, 5000)
	const timeoutMs = clampNumber(url.searchParams.get('timeoutMs'), 25_000, 1000, 120_000)
	const sinceTs = clampNumber(url.searchParams.get('sinceTs'), undefined)
	const grep = normalizeQueryValue(url.searchParams.get('grep'))

	options.onRequest?.({
		endpoint: 'net/tail',
		remoteAddress: res.req.socket.remoteAddress ?? null,
		query: { after, limit, sinceTs, timeoutMs, grep },
		ts: Date.now(),
	})

	const requests = await options.netBuffer.waitForAfter(after, { sinceTs, grep }, limit, timeoutMs)
	const nextAfter = requests.length > 0 ? (requests[requests.length - 1]?.id ?? after) : after
	const response: NetTailResponse = { ok: true, requests, nextAfter, timedOut: requests.length === 0 }
	respondJson(res, response)
}

const handleEval = async (req: http.IncomingMessage, res: http.ServerResponse, options: HttpServerOptions): Promise<void> => {
	const payload = await readJsonBody<EvalRequest>(req, res)
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

	try {
		const response: EvalResponse = await evaluateExpression(options.cdpSession, {
			expression: payload.expression,
			awaitPromise: normalizeBoolean(payload.awaitPromise, true),
			returnByValue: normalizeBoolean(payload.returnByValue, true),
			timeoutMs: normalizeTimeout(payload.timeoutMs),
		})
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}

const handleTraceStart = async (req: http.IncomingMessage, res: http.ServerResponse, options: HttpServerOptions): Promise<void> => {
	const payload = await readJsonBody<TraceStartRequest>(req, res)
	if (!payload) {
		return
	}

	options.onRequest?.({
		endpoint: 'trace/start',
		remoteAddress: res.req.socket.remoteAddress ?? null,
		ts: Date.now(),
	})

	try {
		const response: TraceStartResponse = await options.traceRecorder.start(payload)
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}

const handleTraceStop = async (req: http.IncomingMessage, res: http.ServerResponse, options: HttpServerOptions): Promise<void> => {
	const payload = await readJsonBody<TraceStopRequest>(req, res)
	if (!payload) {
		return
	}

	options.onRequest?.({
		endpoint: 'trace/stop',
		remoteAddress: res.req.socket.remoteAddress ?? null,
		ts: Date.now(),
	})

	try {
		const response: TraceStopResponse = await options.traceRecorder.stop(payload)
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}

const handleScreenshot = async (req: http.IncomingMessage, res: http.ServerResponse, options: HttpServerOptions): Promise<void> => {
	const payload = await readJsonBody<ScreenshotRequest>(req, res)
	if (!payload) {
		return
	}

	options.onRequest?.({
		endpoint: 'screenshot',
		remoteAddress: res.req.socket.remoteAddress ?? null,
		ts: Date.now(),
	})

	try {
		const response: ScreenshotResponse = await options.screenshotter.capture(payload)
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}

const handleDomTree = async (req: http.IncomingMessage, res: http.ServerResponse, options: HttpServerOptions): Promise<void> => {
	const payload = await readJsonBody<DomTreeRequest>(req, res)
	if (!payload) {
		return
	}

	if (!payload.selector || typeof payload.selector !== 'string') {
		return respondInvalidBody(res, 'selector is required')
	}

	const all = payload.all ?? false
	if (typeof all !== 'boolean') {
		return respondInvalidBody(res, 'all must be a boolean')
	}

	options.onRequest?.({
		endpoint: 'dom/tree',
		remoteAddress: res.req.socket.remoteAddress ?? null,
		ts: Date.now(),
	})

	try {
		const response: DomTreeResponse = await fetchDomSubtreeBySelector(options.cdpSession, {
			selector: payload.selector,
			depth: payload.depth,
			maxNodes: payload.maxNodes,
			all,
		})

		// Enforce "single match" policy server-side when all=false
		if (!all && response.matches > 1) {
			return respondJson(
				res,
				{
					ok: false,
					error: {
						message: `Selector matched ${response.matches} elements; pass all=true to return all matches`,
						code: 'multiple_matches',
					},
				},
				400,
			)
		}

		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}

const handleDomInfo = async (req: http.IncomingMessage, res: http.ServerResponse, options: HttpServerOptions): Promise<void> => {
	const payload = await readJsonBody<DomInfoRequest>(req, res)
	if (!payload) {
		return
	}

	if (!payload.selector || typeof payload.selector !== 'string') {
		return respondInvalidBody(res, 'selector is required')
	}

	const all = payload.all ?? false
	if (typeof all !== 'boolean') {
		return respondInvalidBody(res, 'all must be a boolean')
	}

	options.onRequest?.({
		endpoint: 'dom/info',
		remoteAddress: res.req.socket.remoteAddress ?? null,
		ts: Date.now(),
	})

	try {
		const response: DomInfoResponse = await fetchDomInfoBySelector(options.cdpSession, {
			selector: payload.selector,
			all,
			outerHtmlMaxChars: payload.outerHtmlMaxChars,
		})

		// Enforce "single match" policy server-side when all=false
		if (!all && response.matches > 1) {
			return respondJson(
				res,
				{
					ok: false,
					error: {
						message: `Selector matched ${response.matches} elements; pass all=true to return all matches`,
						code: 'multiple_matches',
					},
				},
				400,
			)
		}

		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}

const handleDomHover = async (req: http.IncomingMessage, res: http.ServerResponse, options: HttpServerOptions): Promise<void> => {
	const payload = await readJsonBody<DomHoverRequest>(req, res)
	if (!payload) {
		return
	}

	if (!payload.selector || typeof payload.selector !== 'string') {
		return respondInvalidBody(res, 'selector is required')
	}

	const all = payload.all ?? false
	if (typeof all !== 'boolean') {
		return respondInvalidBody(res, 'all must be a boolean')
	}

	options.onRequest?.({
		endpoint: 'dom/hover',
		remoteAddress: res.req.socket.remoteAddress ?? null,
		ts: Date.now(),
	})

	try {
		const { allNodeIds, nodeIds } = await resolveDomSelectorMatches(options.cdpSession, payload.selector, all)

		if (!all && allNodeIds.length > 1) {
			return respondJson(
				res,
				{
					ok: false,
					error: {
						message: `Selector matched ${allNodeIds.length} elements; pass all=true to hover all matches`,
						code: 'multiple_matches',
					},
				},
				400,
			)
		}

		if (allNodeIds.length === 0) {
			const response: DomHoverResponse = { ok: true, matches: 0, hovered: 0 }
			return respondJson(res, response)
		}

		await hoverDomNodes(options.cdpSession, nodeIds)
		const response: DomHoverResponse = { ok: true, matches: allNodeIds.length, hovered: nodeIds.length }
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}

const handleDomClick = async (req: http.IncomingMessage, res: http.ServerResponse, options: HttpServerOptions): Promise<void> => {
	const payload = await readJsonBody<DomClickRequest>(req, res)
	if (!payload) {
		return
	}

	if (!payload.selector || typeof payload.selector !== 'string') {
		return respondInvalidBody(res, 'selector is required')
	}

	const all = payload.all ?? false
	if (typeof all !== 'boolean') {
		return respondInvalidBody(res, 'all must be a boolean')
	}

	options.onRequest?.({
		endpoint: 'dom/click',
		remoteAddress: res.req.socket.remoteAddress ?? null,
		ts: Date.now(),
	})

	try {
		const { allNodeIds, nodeIds } = await resolveDomSelectorMatches(options.cdpSession, payload.selector, all)

		if (!all && allNodeIds.length > 1) {
			return respondJson(
				res,
				{
					ok: false,
					error: {
						message: `Selector matched ${allNodeIds.length} elements; pass all=true to click all matches`,
						code: 'multiple_matches',
					},
				},
				400,
			)
		}

		if (allNodeIds.length === 0) {
			const response: DomClickResponse = { ok: true, matches: 0, clicked: 0 }
			return respondJson(res, response)
		}

		await clickDomNodes(options.cdpSession, nodeIds)
		const response: DomClickResponse = { ok: true, matches: allNodeIds.length, clicked: nodeIds.length }
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}

const handleStorageLocal = async (req: http.IncomingMessage, res: http.ServerResponse, options: HttpServerOptions): Promise<void> => {
	const payload = await readJsonBody<StorageLocalRequest>(req, res)
	if (!payload) {
		return
	}

	// Validate action
	const validActions = ['get', 'set', 'remove', 'list', 'clear'] as const
	if (!payload.action || !validActions.includes(payload.action)) {
		return respondInvalidBody(res, `action must be one of: ${validActions.join(', ')}`)
	}

	// Validate key is present for get/set/remove
	if (['get', 'set', 'remove'].includes(payload.action) && (!payload.key || typeof payload.key !== 'string')) {
		return respondInvalidBody(res, 'key is required for get/set/remove actions')
	}

	// Validate value is present for set
	if (payload.action === 'set' && (payload.value === undefined || typeof payload.value !== 'string')) {
		return respondInvalidBody(res, 'value is required for set action')
	}

	options.onRequest?.({
		endpoint: 'storage/local',
		remoteAddress: res.req.socket.remoteAddress ?? null,
		ts: Date.now(),
	})

	try {
		const response = await executeStorageLocal(options.cdpSession, payload)
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
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
