import type { NetWebSocketFramesQuery, NetWebSocketFramesResponse, NetWebSocketResponse, NetWebSocketsResponse } from '@vforsh/argus-core'
import { toSearchParams } from '@vforsh/argus-core'
import type { NetCliListOptions } from './netShared.js'
import { appendNetCommandParams } from './netShared.js'
import { defineWatcherCommand } from '../cli/defineWatcherCommand.js'
import { fetchJson } from '../httpClient.js'
import { createOutput, type Output } from '../output/io.js'
import { formatWebSocketDetail, formatWebSocketFrameLine, formatWebSocketSummary } from '../output/net.js'
import { parseNumber, parsePositiveInt } from '../cli/parse.js'
import { normalizeMatchPatterns, resolveSinceTimestamp } from '../watchers/queryParams.js'
import { buildWatcherUrl, formatWatcherTransportError, resolveWatcherOrExit } from '../watchers/requestWatcher.js'

export type NetWebSocketOptions = NetCliListOptions & {
	json?: boolean
}

export type NetWebSocketShowOptions = {
	json?: boolean
}

export const runNetWebSocket = defineWatcherCommand<NetWebSocketOptions, NetWebSocketsResponse>({
	build: (_args, options, output) => {
		const params = new URLSearchParams()
		const query = appendNetCommandParams(params, options)
		if (query.error) {
			output.writeWarn(query.error)
			process.exitCode = 2
			return null
		}
		return { path: '/net/ws', query: params, timeoutMs: 5_000 }
	},
	formatJson: (response) => response.connections,
	formatHuman: (response, { output }) => {
		for (const connection of response.connections) {
			output.writeHuman(formatWebSocketSummary(connection))
		}
	},
})

export const runNetWebSocketShow = defineWatcherCommand<NetWebSocketShowOptions, NetWebSocketResponse, unknown, [connection: string]>({
	build: ([connection], _options, output) => {
		const query = new URLSearchParams()
		if (/^\d+$/.test(connection)) {
			query.set('id', connection)
		} else if (connection.trim()) {
			query.set('requestId', connection)
		} else {
			output.writeWarn('Missing WebSocket connection id.')
			process.exitCode = 2
			return null
		}
		return { path: '/net/ws/connection', query, timeoutMs: 5_000 }
	},
	formatJson: (response) => response.connection,
	formatHuman: (response, { output }) => {
		for (const line of formatWebSocketDetail(response.connection)) {
			output.writeHuman(line)
		}
	},
})

/** Options shared by `net ws frames` and `net ws tail`. */
export type NetWebSocketFrameOptions = {
	socket?: string
	direction?: string
	grep?: string
	match?: string[]
	caseSensitive?: boolean
	since?: string
	after?: string
	limit?: string
	maxChars?: string
	json?: boolean
}

export type NetWebSocketTailOptions = NetWebSocketFrameOptions & {
	timeout?: string
}

/** One-shot read of buffered frames, oldest first. */
export const runNetWebSocketFrames = defineWatcherCommand<NetWebSocketFrameOptions, NetWebSocketFramesResponse>({
	build: (_args, options, output) => {
		const query = buildFrameQuery(options, output)
		return query ? { path: '/net/ws/frames', query: toSearchParams(query), timeoutMs: 5_000 } : null
	},
	formatJson: (response) => response.frames,
	formatHuman: (response, { output }) => {
		for (const frame of response.frames) {
			output.writeHuman(formatWebSocketFrameLine(frame))
		}
	},
})

/** Follow new frames via long-polling until interrupted. Starts at the end of the buffer unless `--after`/`--since` is given. */
export const runNetWebSocketTail = async (id: string | undefined, options: NetWebSocketTailOptions): Promise<void> => {
	const output = createOutput(options)
	const query = buildFrameQuery(options, output)
	if (!query) return
	const timeoutMs = parseNumber(options.timeout) ?? 25_000

	const resolved = await resolveWatcherOrExit({ id }, output)
	if (!resolved) return
	const { watcher } = resolved

	let running = true
	const stop = (): void => {
		running = false
	}
	process.on('SIGINT', stop)
	process.on('SIGTERM', stop)

	let after = query.after ?? (query.sinceTs != null ? 0 : await readFrameCursor(watcher, query, output))
	if (after == null) return

	while (running) {
		const params = toSearchParams({ ...query, after, timeoutMs } satisfies NetWebSocketFramesQuery)
		let response: NetWebSocketFramesResponse
		try {
			response = await fetchJson<NetWebSocketFramesResponse>(buildWatcherUrl(watcher, '/net/ws/frames', params), { timeoutMs: timeoutMs + 5_000 })
		} catch (error) {
			output.writeWarn(formatWatcherTransportError(watcher, error))
			process.exitCode = 1
			return
		}

		for (const frame of response.frames) {
			if (options.json) {
				output.writeJsonLine({ watcher: watcher.id, frame })
				continue
			}
			output.writeHuman(formatWebSocketFrameLine(frame))
		}
		after = response.nextAfter
	}
}

/**
 * The newest frame id, so a plain `tail` prints only what arrives from now on (like `tail -f` after `-n 0`).
 * One request: draining pages instead never finished on a socket busier than the drain. The socket filter is
 * applied so a bad `--socket` fails here with the watcher's 404.
 */
const readFrameCursor = async (
	watcher: { id: string; host: string; port: number },
	query: NetWebSocketFramesQuery,
	output: Output,
): Promise<number | null> => {
	try {
		const params = toSearchParams({ socket: query.socket, limit: 1, maxPayloadChars: 1 } satisfies NetWebSocketFramesQuery)
		const response = await fetchJson<NetWebSocketFramesResponse>(buildWatcherUrl(watcher, '/net/ws/frames', params), { timeoutMs: 5_000 })
		return response.latestId
	} catch (error) {
		output.writeWarn(formatWatcherTransportError(watcher, error))
		process.exitCode = 1
		return null
	}
}

const buildFrameQuery = (options: NetWebSocketFrameOptions, output: Output): NetWebSocketFramesQuery | null => {
	const fail = (message: string): null => {
		output.writeWarn(message)
		process.exitCode = 2
		return null
	}

	const direction = normalizeDirection(options.direction)
	if (direction === false) return fail(`Invalid --direction value: ${options.direction}. Expected sent, received (or out, in).`)
	const match = normalizeMatchPatterns(options.match)
	if (match.error) return fail(match.error)
	const since = resolveSinceTimestamp(options.since)
	if (since.error) return fail(since.error)
	const maxPayloadChars = options.maxChars === undefined ? undefined : parsePositiveInt(options.maxChars)
	if (options.maxChars !== undefined && maxPayloadChars === undefined) return fail('Invalid --max-chars value: expected a positive integer.')

	return {
		socket: options.socket,
		direction,
		grep: options.grep,
		match: match.patterns,
		matchCase: options.caseSensitive ? 'sensitive' : undefined,
		sinceTs: since.sinceTs ?? undefined,
		after: parseNumber(options.after),
		limit: parseNumber(options.limit),
		maxPayloadChars,
	}
}

const DIRECTION_ALIASES: Record<string, 'sent' | 'received'> = {
	sent: 'sent',
	send: 'sent',
	out: 'sent',
	received: 'received',
	recv: 'received',
	in: 'received',
}

const normalizeDirection = (value: string | undefined): 'sent' | 'received' | undefined | false => {
	if (value == null || value.trim() === '') return undefined
	return DIRECTION_ALIASES[value.trim().toLowerCase()] ?? false
}
