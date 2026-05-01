import type { NetWebSocketResponse, NetWebSocketsResponse } from '@vforsh/argus-core'
import type { NetCliListOptions } from './netShared.js'
import { appendNetCommandParams } from './netShared.js'
import { requestWatcherCommandAction } from '../cli/defineWatcherCommand.js'
import { formatWebSocketDetail, formatWebSocketSummary } from '../output/net.js'
import { createOutput } from '../output/io.js'

export type NetWebSocketOptions = NetCliListOptions & {
	json?: boolean
}

export type NetWebSocketShowOptions = {
	json?: boolean
}

export const runNetWebSocket = async (id: string | undefined, options: NetWebSocketOptions): Promise<void> => {
	const output = createOutput(options)
	const params = new URLSearchParams()
	const query = appendNetCommandParams(params, options)
	if (query.error) {
		output.writeWarn(query.error)
		process.exitCode = 2
		return
	}

	const result = await requestWatcherCommandAction<NetWebSocketsResponse>({ id, path: '/net/ws', query: params, timeoutMs: 5_000 }, output)
	if (!result) {
		return
	}

	if (options.json) {
		output.writeJson(result.data.connections)
		return
	}

	for (const connection of result.data.connections) {
		output.writeHuman(formatWebSocketSummary(connection))
	}
}

export const runNetWebSocketShow = async (id: string | undefined, connection: string, options: NetWebSocketShowOptions): Promise<void> => {
	const output = createOutput(options)
	const query = buildConnectionQuery(connection, output)
	if (!query) {
		return
	}

	const result = await requestWatcherCommandAction<NetWebSocketResponse>({ id, path: '/net/ws/connection', query, timeoutMs: 5_000 }, output)
	if (!result) {
		return
	}

	if (options.json) {
		output.writeJson(result.data.connection)
		return
	}

	for (const line of formatWebSocketDetail(result.data.connection)) {
		output.writeHuman(line)
	}
}

const buildConnectionQuery = (connection: string, output: ReturnType<typeof createOutput>): URLSearchParams | null => {
	const query = new URLSearchParams()
	if (/^\d+$/.test(connection)) {
		query.set('id', connection)
		return query
	}

	if (!connection.trim()) {
		output.writeWarn('Missing WebSocket connection id.')
		process.exitCode = 2
		return null
	}

	query.set('requestId', connection)
	return query
}
