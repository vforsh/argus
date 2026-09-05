import type { LogLevel, NetParty, NetRequestBodyPart, NetScope } from '@vforsh/argus-core'

/**
 * Every endpoint the watcher serves, as it appears in the public `httpRequested` event.
 *
 * One list, imported by both the HTTP server's request metadata and the public event type. It
 * used to be hand-maintained in both files, so adding a route meant editing the same 61 literals
 * twice or emitting an endpoint the public event could not name.
 */
export const WATCHER_ENDPOINTS = [
	'logs',
	'tail',
	'net',
	'net/requests',
	'net/request',
	'net/request/body',
	'net/tail',
	'net/clear',
	'net/mock',
	'net/mock/add',
	'net/mock/remove',
	'net/mock/clear',
	'net/ws',
	'net/ws/connection',
	'net/sse',
	'auth/cookies',
	'auth/cookies/get',
	'auth/cookies/set',
	'auth/cookies/delete',
	'auth/cookies/clear',
	'auth/state',
	'auth/state/load',
	'eval',
	'trace/start',
	'trace/stop',
	'record',
	'record/start',
	'record/stop',
	'record/status',
	'screenshot',
	'snapshot',
	'locate/role',
	'locate/text',
	'locate/label',
	'code/list',
	'code/read',
	'code/grep',
	'code/edit',
	'dom/tree',
	'dom/info',
	'dom/hover',
	'dom/click',
	'dom/drag',
	'dom/keydown',
	'dom/add',
	'dom/remove',
	'dom/modify',
	'dom/set-file',
	'dom/focus',
	'dom/fill',
	'dom/scroll',
	'dom/scroll-to',
	'emulation',
	'throttle',
	'dialog/status',
	'dialog/handle',
	'visibility',
	'storage/local',
	'storage/session',
	'reload',
	'shutdown',
	'tabs',
	'extension/diagnostics',
	'targets',
	'attach',
	'detach',
] as const

/** An endpoint the watcher serves. */
export type WatcherEndpoint = (typeof WATCHER_ENDPOINTS)[number]

/**
 * Query parameters reported alongside a served request.
 *
 * Deliberately one all-optional shape rather than a union per endpoint family. The union that
 * used to sit on the public event was decorative: its `TabListRequestQuery` arm was all-optional,
 * so TypeScript's weak-type check accepted essentially any of the other arms' objects and nothing
 * was ever actually discriminated — while every new route still had to be added to both models.
 */
export type WatcherRequestQuery = {
	id?: number
	requestId?: string
	part?: NetRequestBodyPart
	/** Opaque cursor for logs; numeric record cursor for net. */
	after?: number | string
	sinceEpoch?: string
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
