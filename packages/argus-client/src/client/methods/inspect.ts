import type {
	LogCursorResponse,
	LogEpochResponse,
	LogsResponse,
	NetClearResponse,
	NetRequestResponse,
	NetResponse,
	RegistryV1,
	StatusResponse,
} from '@vforsh/argus-core'
import type { ListOptions, ListResult, LogsOptions, LogsResult, NetOptions, NetResult } from '../../types.js'
import { previewLogEvent } from '../../logs/previewLogEvent.js'
import { readAndPruneRegistry } from '../../registry/readAndPruneRegistry.js'
import type { ClientContext } from '../context.js'
import { buildLogsParams, buildNetParams } from '../queryParams.js'
import { requestWatcher } from '../watcherRequest.js'

/** Registry, log, and network read methods. */
export const createInspectMethods = (ctx: ClientContext) => ({
	list: async (options: ListOptions = {}): Promise<ListResult[]> => {
		const registry = await readAndPruneRegistry({ registryPath: ctx.registryPath, ttlMs: ctx.ttlMs })
		const byCwd = normalizeByCwd(options.byCwd)
		const watchers = byCwd ? filterByCwd(registry, byCwd) : Object.values(registry.watchers)

		const results: ListResult[] = []
		for (const watcher of watchers) {
			try {
				const { data: status } = await requestWatcher<StatusResponse>(ctx, watcher.id, {
					path: '/status',
					timeoutMs: ctx.listTimeoutMs,
				})
				results.push({ watcher, reachable: true, status })
			} catch (error) {
				results.push({ watcher, reachable: false, error: formatError(error) })
			}
		}

		return results
	},

	logs: async (watcherId: string, options: LogsOptions = {}): Promise<LogsResult> => {
		const { data: response } = await requestWatcher<LogsResponse>(ctx, watcherId, {
			path: '/logs',
			query: buildLogsParams(options),
			timeoutMs: ctx.requestTimeoutMs,
		})

		const mode = options.mode ?? 'preview'
		const events = mode === 'full' ? response.events : response.events.map((event) => previewLogEvent(event))

		return { events, nextCursor: response.nextCursor }
	},

	logCursor: async (watcherId: string) => {
		const { data } = await requestWatcher<LogCursorResponse>(ctx, watcherId, {
			path: '/logs/cursor',
			timeoutMs: ctx.requestTimeoutMs,
		})
		return { cursor: data.cursor }
	},

	beginLogEpoch: async (watcherId: string) => {
		const { data } = await requestWatcher<LogEpochResponse>(ctx, watcherId, {
			path: '/logs/epoch',
			timeoutMs: ctx.requestTimeoutMs,
		})
		return { epoch: data.epoch }
	},

	net: async (watcherId: string, options: NetOptions = {}): Promise<NetResult> => {
		const { data: response } = await requestWatcher<NetResponse>(ctx, watcherId, {
			path: '/net',
			query: buildNetParams(options),
			timeoutMs: ctx.requestTimeoutMs,
		})

		return { requests: response.requests, nextAfter: response.nextAfter }
	},

	netRequest: async (watcherId: string, request: number | string) => {
		const { data: response } = await requestWatcher<NetRequestResponse>(ctx, watcherId, {
			path: '/net/request',
			query: buildNetRequestParams(request),
			timeoutMs: ctx.requestTimeoutMs,
		})

		return response.request
	},

	netClear: async (watcherId: string) => {
		const { data } = await requestWatcher<NetClearResponse>(ctx, watcherId, {
			path: '/net/clear',
			timeoutMs: ctx.requestTimeoutMs,
			method: 'POST',
			body: {},
		})
		return { cleared: data.cleared }
	},
})

/** Build the lookup query for one buffered request, accepting a sequence number or a request id. */
const buildNetRequestParams = (request: number | string): URLSearchParams => {
	const params = new URLSearchParams()

	if (typeof request === 'number') {
		if (!Number.isFinite(request) || request < 1) {
			throw new Error(`Invalid request value: ${request}`)
		}
		params.set('id', String(request))
		return params
	}

	const normalized = request.trim()
	if (!normalized) {
		throw new Error('request is required')
	}
	params.set(/^\d+$/.test(normalized) ? 'id' : 'requestId', normalized)

	return params
}

const normalizeByCwd = (value?: string): string | undefined => {
	if (value == null) {
		return undefined
	}

	const trimmed = value.trim()
	return trimmed ? trimmed : undefined
}

const filterByCwd = (registry: RegistryV1, byCwd: string) =>
	Object.values(registry.watchers).filter((watcher) => watcher.cwd && watcher.cwd.includes(byCwd))

const formatError = (error: unknown): string => {
	if (!error) {
		return 'unknown error'
	}
	if (error instanceof Error) {
		return error.message
	}
	return String(error)
}
