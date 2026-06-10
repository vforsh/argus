import type { NetWebSocketResponse, NetWebSocketsResponse } from '@vforsh/argus-core'
import type { NetCliListOptions } from './netShared.js'
import { appendNetCommandParams } from './netShared.js'
import { defineWatcherCommand } from '../cli/defineWatcherCommand.js'
import { formatWebSocketDetail, formatWebSocketSummary } from '../output/net.js'

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
