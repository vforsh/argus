import type { NetTailResponse } from '@vforsh/argus-core'
import type { NetCliListOptions } from './netShared.js'
import { appendNetCommandParams } from './netShared.js'
import { fetchJson } from '../httpClient.js'
import { formatNetworkRequest } from '../output/format.js'
import { createOutput } from '../output/io.js'
import { parseNumber } from '../cli/parse.js'
import { buildWatcherUrl, formatWatcherTransportError, resolveWatcherOrExit } from '../watchers/requestWatcher.js'

/** Options for the net tail command. */
export type NetTailOptions = NetCliListOptions & {
	json?: boolean
	timeout?: string
}

/** Execute the net tail command for a watcher id. */
export const runNetTail = async (id: string | undefined, options: NetTailOptions): Promise<void> => {
	const output = createOutput(options)
	const resolved = await resolveWatcherOrExit({ id }, output)
	if (!resolved) return

	const { watcher } = resolved

	let after = parseNumber(options.after) ?? 0
	const timeoutMs = parseNumber(options.timeout) ?? 25_000

	let running = true
	const stop = (): void => {
		running = false
	}

	process.on('SIGINT', stop)
	process.on('SIGTERM', stop)

	while (running) {
		const params = new URLSearchParams()
		params.set('after', String(after))
		params.set('timeoutMs', String(timeoutMs))
		const query = appendNetCommandParams(params, options, { includeAfter: false })
		if (query.error) {
			output.writeWarn(query.error)
			process.exitCode = 2
			return
		}

		const url = buildWatcherUrl(watcher, '/net/tail', params)
		let response: NetTailResponse
		try {
			response = await fetchJson<NetTailResponse>(url, { timeoutMs: timeoutMs + 5_000 })
		} catch (error) {
			output.writeWarn(formatWatcherTransportError(watcher, error))
			process.exitCode = 1
			return
		}

		if (response.requests.length > 0) {
			for (const request of response.requests) {
				if (options.json) {
					output.writeJsonLine({ watcher: watcher.id, request })
					continue
				}
				output.writeHuman(formatNetworkRequest(request))
			}
		}

		after = response.nextAfter
	}
}
