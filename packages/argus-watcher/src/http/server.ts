import http from 'node:http'
import type { AuthStateCookie, DialogStatus, LogLevel, NetRequestBodyPart, WatcherRecord } from '@vforsh/argus-core'
import type { LogBuffer } from '../buffer/LogBuffer.js'
import type { NetBuffer } from '../buffer/NetBuffer.js'
import type { CdpSessionHandle } from '../cdp/connection.js'
import type { ElementRefRegistry } from '../cdp/elementRefs.js'
import type { RuntimeEditor } from '../cdp/editor.js'
import type { TraceRecorder } from '../cdp/tracing.js'
import type { Screenshotter } from '../cdp/screenshot.js'
import type { CdpSourceCookieQuery, CdpSourceHandle, CdpSourceStatus } from '../sources/types.js'
import type { EmulationController } from '../emulation/EmulationController.js'
import type { ThrottleController } from '../throttle/ThrottleController.js'
import type { NetFilterContext, NetParty, NetScope } from '../net/filtering.js'
import { dispatch } from './router.js'

/** Optional metadata for the HTTP request event. */
export type HttpRequestEventMetadata = {
	endpoint:
		| 'logs'
		| 'tail'
		| 'net'
		| 'net/requests'
		| 'net/request'
		| 'net/request/body'
		| 'net/tail'
		| 'net/clear'
		| 'auth/cookies'
		| 'auth/cookies/get'
		| 'auth/cookies/set'
		| 'auth/cookies/delete'
		| 'auth/cookies/clear'
		| 'auth/state'
		| 'auth/state/load'
		| 'eval'
		| 'trace/start'
		| 'trace/stop'
		| 'screenshot'
		| 'snapshot'
		| 'locate/role'
		| 'locate/text'
		| 'locate/label'
		| 'code/list'
		| 'code/read'
		| 'code/grep'
		| 'code/edit'
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
		| 'throttle'
		| 'dialog/status'
		| 'dialog/handle'
		| 'storage/local'
		| 'storage/session'
		| 'reload'
		| 'shutdown'
		| 'tabs'
		| 'targets'
		| 'attach'
		| 'detach'
	remoteAddress: string | null
	query?: {
		id?: number
		requestId?: string
		part?: NetRequestBodyPart
		after?: number
		limit?: number
		levels?: LogLevel[]
		match?: string[]
		matchCase?: 'sensitive' | 'insensitive'
		source?: string
		sinceTs?: number
		timeoutMs?: number
		grep?: string
		hosts?: string[]
		methods?: string[]
		statuses?: string[]
		resourceTypes?: string[]
		mimeTypes?: string[]
		scope?: NetScope
		frame?: string
		party?: NetParty
		failedOnly?: boolean
		minDurationMs?: number
		minTransferBytes?: number
		ignoreHosts?: string[]
		ignorePatterns?: string[]
		origin?: string
		domain?: string
		url?: string
		title?: string
		includeValues?: boolean
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
	getCdpStatus: () => Pick<CdpSourceStatus, 'attached' | 'target' | 'targetReady'>
	getDialog: () => DialogStatus | null
	elementRefs: ElementRefRegistry
	/** Session for page-scoped commands that must always target the top-level page. */
	pageCdpSession: CdpSessionHandle
	cdpSession: CdpSessionHandle
	traceRecorder: TraceRecorder
	screenshotter: Screenshotter
	runtimeEditor: RuntimeEditor
	/** Emulation controller for GET/POST /emulation endpoints. */
	emulationController: EmulationController
	/** Throttle controller for GET/POST /throttle endpoints. */
	throttleController: ThrottleController
	/** Source handle for extension mode (enables /targets, /attach, /detach endpoints). */
	sourceHandle?: CdpSourceHandle
	/** Best-effort target metadata for resolving net scope filters. */
	getNetFilterContext?: () => NetFilterContext | null
	/** Optional browser-cookie reader when the source can access cookies outside the page's request scope. */
	readBrowserCookies?: (query: CdpSourceCookieQuery) => Promise<AuthStateCookie[]>
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
