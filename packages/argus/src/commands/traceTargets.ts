import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import type { StatusResponse, WatcherRecord } from '@vforsh/argus-core'
import type { Output } from '../output/io.js'
import { setExitCode } from '../output/exitCode.js'
import { loadActiveRegistry } from '../registry.js'
import { fetchJson } from '../httpClient.js'
import { fetchWatcherJson, formatWatcherTransportError } from '../watchers/requestWatcher.js'
import { resolveArtifactOutFile } from '../utils/paths.js'
import { isTraceConflict, writeTraceError } from './traceHolder.js'

/** One traced watcher and the renderer process its page ran in. */
export type TraceRendererLabel = {
	watcherId: string
	targetId: string
	url: string | null
	/** Renderer pid, or `null` when the trace never mentioned the watcher's frame. */
	pid: number | null
}

/** Result of `argus trace --targets … --duration …`. */
export type TraceTargetsResult = {
	ok: true
	outFile: string
	eventCount: number
	durationMs: number
	renderers: TraceRendererLabel[]
}

type TraceEvent = { name?: string; pid?: number; args?: { data?: Record<string, unknown> } }

const EXTENSION_MODE_REASON =
	'A multi-tab trace needs direct CDP watchers. In extension mode every trace runs through one tab\'s chrome.debugger session, which Chrome scopes to that tab\'s renderer, and chrome.debugger cannot attach to the browser target that would cover all tabs. Trace each tab on its own, or run Chrome with `argus chrome start` and attach CDP watchers (`argus watcher start`).'

/**
 * Trace several watchers' tabs in one Chrome tracing session.
 *
 * A watcher's own session is page-scoped, and Chrome limits a page-scoped trace to that page's
 * renderer. The browser target has no such limit, so this connects to it directly for the duration
 * of the capture and labels each watcher's renderer pid in the output. It only exists as a
 * fixed-duration capture: the CLI process must own the browser socket from start to end.
 */
export const runTraceTargets = async (
	targetIds: string[],
	options: { out?: string; categories?: string; options?: string },
	durationMs: number,
	output: Output,
): Promise<TraceTargetsResult | null> => {
	const watchers = await resolveTraceWatchers(targetIds, output)
	if (!watchers) {
		return null
	}

	const targets: Array<{ watcher: WatcherRecord; targetId: string; url: string | null }> = []
	for (const watcher of watchers) {
		let status: StatusResponse
		try {
			status = await fetchWatcherJson<StatusResponse>(watcher, { path: '/status', timeoutMs: 3_000 })
		} catch (error) {
			return fail(output, formatWatcherTransportError(watcher, error))
		}
		const targetId = status.attached ? status.target?.id : null
		if (!targetId) {
			return fail(output, `${watcher.id}: watcher is not attached to a page, or is too old to report its target id (restart it)`)
		}
		targets.push({ watcher, targetId, url: status.target?.url ?? null })
	}

	const chrome = watchers[0]!.chrome!
	let wsUrl: string
	try {
		const version = await fetchJson<{ webSocketDebuggerUrl?: string }>(`http://${chrome.host}:${chrome.port}/json/version`, { timeoutMs: 3_000 })
		if (!version.webSocketDebuggerUrl) {
			return fail(output, `Chrome at ${chrome.host}:${chrome.port} reported no browser websocket`)
		}
		wsUrl = version.webSocketDebuggerUrl
	} catch (error) {
		return fail(output, `Chrome at ${chrome.host}:${chrome.port} is unreachable: ${error instanceof Error ? error.message : String(error)}`)
	}

	const outFile =
		resolveArtifactOutFile(options.out) ??
		path.join(os.tmpdir(), 'argus', 'traces', `trace-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
	await fs.promises.mkdir(path.dirname(outFile), { recursive: true })

	const session = await openBrowserSession(wsUrl).catch((error: unknown) => {
		fail(output, `Failed to connect to Chrome's browser target: ${error instanceof Error ? error.message : String(error)}`)
		return null
	})
	if (!session) {
		return null
	}

	// Renderer pids are only knowable from the trace itself, so keep the events in memory until the
	// labels can be appended alongside them. Traces of a few seconds stay well within reach.
	const events: TraceEvent[] = []
	const complete = new Promise<void>((resolve) => {
		session.onEvent((method, params) => {
			if (method === 'Tracing.dataCollected') {
				const value = (params as { value?: TraceEvent[] }).value
				if (Array.isArray(value)) events.push(...value)
			} else if (method === 'Tracing.tracingComplete') {
				resolve()
			}
		})
	})

	try {
		const startedAt = Date.now()
		try {
			await session.send('Tracing.start', {
				categories: withLabelCategory(options.categories),
				options: options.options,
				transferMode: 'ReportEvents',
			})
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			await writeTraceError(
				{ id: '', source: 'cdp', chrome },
				{ ok: false, error: { message, code: isTraceConflict(message) ? 'trace_conflict' : undefined } },
				output,
			)
			return null
		}

		await markTracedPages(watchers)
		await new Promise((resolve) => setTimeout(resolve, Math.max(0, durationMs - (Date.now() - startedAt))))
		await session.send('Tracing.end', {})
		await withTimeout(Promise.race([complete, session.closed]), 20_000, 'Timed out waiting for Chrome to flush the trace')

		const renderers = labelRenderers(events, targets)
		await writeTraceFile(outFile, events, renderers)
		return { ok: true, outFile, eventCount: events.length, durationMs: Date.now() - startedAt, renderers }
	} catch (error) {
		return fail(output, error instanceof Error ? error.message : String(error))
	} finally {
		session.close()
	}
}

/**
 * Renderer labels come from frame-tagged `devtools.timeline` events (see {@link labelRenderers}).
 * Chrome's default categories include it; an explicit list gets it appended.
 */
const withLabelCategory = (categories: string | undefined): string | undefined => {
	if (!categories?.trim()) return categories
	const list = categories.split(',').map((category) => category.trim())
	return list.includes('devtools.timeline') ? categories : [...list, 'devtools.timeline'].join(',')
}

const resolveTraceWatchers = async (ids: string[], output: Output): Promise<WatcherRecord[] | null> => {
	const registry = await loadActiveRegistry()
	const watchers: WatcherRecord[] = []
	for (const id of ids) {
		const watcher = registry.watchers[id]
		if (!watcher) {
			return fail(output, `Watcher not found: ${id}`, 2)
		}
		if (watcher.source === 'extension') {
			return fail(output, `${id}: extension-mode watcher. ${EXTENSION_MODE_REASON}`, 2)
		}
		if (!watcher.chrome) {
			return fail(output, `${id}: watcher record has no Chrome endpoint`, 2)
		}
		watchers.push(watcher)
	}

	const [first] = watchers
	const other = watchers.find((watcher) => watcher.chrome!.host !== first!.chrome!.host || watcher.chrome!.port !== first!.chrome!.port)
	if (other) {
		return fail(
			output,
			`Watchers "${first!.id}" and "${other.id}" use different Chrome instances (${first!.chrome!.host}:${first!.chrome!.port} vs ${other.chrome!.host}:${other.chrome!.port}); one trace can only cover one browser`,
			2,
		)
	}
	return watchers
}

/**
 * Map each watcher's main frame to the renderer that hosted it. Chrome names a page target's main
 * frame with the target id. `TracingStartedInBrowser` / `FrameCommittedInBrowser` state frame → pid
 * outright (the last commit wins across navigations), but need the disabled-by-default timeline
 * category; with Chrome's default categories, the frame-tagged `devtools.timeline` events a page's
 * own tasks emit (TimerFire, FunctionCall, …) are what is there to go on.
 */
const labelRenderers = (events: TraceEvent[], targets: Array<{ watcher: WatcherRecord; targetId: string; url: string | null }>): TraceRendererLabel[] => {
	const declared = new Map<string, number>()
	const observed = new Map<string, number>()
	for (const event of events) {
		const data = event.args?.data
		if (!data) continue
		if (event.name === 'TracingStartedInBrowser' && Array.isArray(data.frames)) {
			for (const frame of data.frames as Array<{ frame?: string; processId?: number }>) {
				if (frame.frame && typeof frame.processId === 'number') declared.set(frame.frame, frame.processId)
			}
		} else if (event.name === 'FrameCommittedInBrowser' && typeof data.frame === 'string' && typeof data.processId === 'number') {
			declared.set(data.frame, data.processId)
		} else if (typeof data.frame === 'string' && typeof event.pid === 'number') {
			observed.set(data.frame, event.pid)
		}
	}
	return targets.map(({ watcher, targetId, url }) => ({
		watcherId: watcher.id,
		targetId,
		url,
		pid: declared.get(targetId) ?? observed.get(targetId) ?? null,
	}))
}

/**
 * Schedule one timer in each traced page, so even an idle tab leaves a frame-tagged `TimerFire`
 * in the trace for {@link labelRenderers}. Best-effort: a tab that can't eval just stays unlabelled.
 */
const markTracedPages = async (watchers: WatcherRecord[]): Promise<void> => {
	await Promise.all(
		watchers.map((watcher) =>
			fetchWatcherJson(watcher, { path: '/eval', method: 'POST', body: { expression: 'setTimeout(() => {}, 0); 0' }, timeoutMs: 2_000 }).catch(
				() => null,
			),
		),
	)
}

/**
 * Write the trace with each labelled renderer named by its watcher: a `process_labels` metadata
 * event shows up next to the process in DevTools and Perfetto, and `metadata.argusRenderers`
 * keeps the full mapping for scripts.
 */
const writeTraceFile = async (outFile: string, events: TraceEvent[], renderers: TraceRendererLabel[]): Promise<void> => {
	const stream = fs.createWriteStream(outFile, { encoding: 'utf8' })
	stream.write('{"traceEvents":[')
	let first = true
	const writeEvent = (event: unknown) => {
		stream.write(first ? JSON.stringify(event) : `,${JSON.stringify(event)}`)
		first = false
	}
	for (const event of events) {
		writeEvent(event)
	}
	for (const renderer of renderers) {
		if (renderer.pid == null) continue
		writeEvent({ ph: 'M', name: 'process_labels', pid: renderer.pid, tid: 0, ts: 0, args: { labels: `argus:${renderer.watcherId}` } })
	}
	stream.write(`],"metadata":${JSON.stringify({ argusRenderers: renderers })}}`)
	stream.end()
	await once(stream, 'finish')
}

type BrowserSession = {
	send: (method: string, params: Record<string, unknown>) => Promise<unknown>
	onEvent: (handler: (method: string, params: unknown) => void) => void
	/** Rejects once Chrome closes the socket, so waits on events that will never come can bail out. */
	closed: Promise<never>
	close: () => void
}

const CONNECT_TIMEOUT_MS = 5_000
const COMMAND_TIMEOUT_MS = 15_000

/**
 * A minimal browser-target CDP client: request/response by id, plus one event listener. Every wait
 * is bounded: a socket closed mid-capture silently drops later sends, which would otherwise hang.
 */
const openBrowserSession = async (wsUrl: string): Promise<BrowserSession> => {
	const ws = new WebSocket(wsUrl)
	const opened = new Promise<void>((resolve, reject) => {
		ws.addEventListener('open', () => resolve(), { once: true })
		ws.addEventListener('error', () => reject(new Error('WebSocket error')), { once: true })
	})
	try {
		await withTimeout(opened, CONNECT_TIMEOUT_MS, `Timed out connecting to ${wsUrl}`)
	} catch (error) {
		ws.close()
		throw error
	}

	let nextId = 1
	const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
	let eventHandler: ((method: string, params: unknown) => void) | null = null

	ws.addEventListener('message', (event) => {
		const message = JSON.parse(String(event.data)) as { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } }
		if (message.id != null) {
			const request = pending.get(message.id)
			pending.delete(message.id)
			if (message.error) request?.reject(new Error(message.error.message ?? 'CDP request failed'))
			else request?.resolve(message.result)
		} else if (message.method) {
			eventHandler?.(message.method, message.params)
		}
	})
	const closedError = () => new Error('Chrome closed the browser websocket')
	const closed = new Promise<never>((_, reject) => {
		ws.addEventListener('close', () => {
			for (const request of pending.values()) request.reject(closedError())
			pending.clear()
			reject(closedError())
		})
	})
	closed.catch(() => {})

	const send = (method: string, params: Record<string, unknown>): Promise<unknown> => {
		if (ws.readyState !== WebSocket.OPEN) {
			return Promise.reject(closedError())
		}
		const id = nextId++
		const response = new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject })
			ws.send(JSON.stringify({ id, method, params }))
		})
		return withTimeout(response, COMMAND_TIMEOUT_MS, `Chrome did not answer ${method} within ${COMMAND_TIMEOUT_MS}ms`).finally(() => pending.delete(id))
	}

	return {
		send,
		onEvent: (handler) => {
			eventHandler = handler
		},
		closed,
		close: () => ws.close(),
	}
}

const withTimeout = async <T>(promise: Promise<T>, ms: number, message: string): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([promise, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)))])
	} finally {
		clearTimeout(timer)
	}
}

const fail = (output: Output, message: string, exitCode = 1): null => {
	if (output.json) {
		output.writeJson({ ok: false, error: { message } })
	} else {
		output.writeWarn(message)
	}
	setExitCode(exitCode)
	return null
}
