import http from 'node:http'
import type { LogLevel, WatcherRecord } from '@vforsh/argus-core'
import type { LogBuffer } from '../buffer/LogBuffer.js'
import type { NetBuffer } from '../buffer/NetBuffer.js'
import type { CdpSessionHandle } from '../cdp/connection.js'
import type { TraceRecorder } from '../cdp/tracing.js'
import type { Screenshotter } from '../cdp/screenshot.js'
import type { CdpSourceHandle } from '../sources/types.js'
import type { EmulationController } from '../emulation/EmulationController.js'
import { dispatch } from './router.js'

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
		| 'snapshot'
		| 'dom/tree'
		| 'dom/info'
		| 'dom/hover'
		| 'dom/click'
		| 'dom/keydown'
		| 'dom/add'
		| 'dom/remove'
		| 'dom/modify'
		| 'dom/set-file'
		| 'dom/focus'
		| 'dom/fill'
		| 'dom/scroll'
		| 'dom/scroll-to'
		| 'emulation'
		| 'storage/local'
		| 'reload'
		| 'shutdown'
		| 'targets'
		| 'attach'
		| 'detach'
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
	/** Emulation controller for GET/POST /emulation endpoints. */
	emulationController: EmulationController
	/** Source handle for extension mode (enables /targets, /attach, /detach endpoints). */
	sourceHandle?: CdpSourceHandle
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
	const server = http.createServer((req, res) => {
		const url = new URL(req.url ?? '/', `http://${req.headers.host ?? options.host}`)
		dispatch(req, res, url, options)
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
