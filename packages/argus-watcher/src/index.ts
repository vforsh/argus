import type { WatcherMatch, WatcherChrome, WatcherRecord, LogEvent } from 'argus-core'
import { startCdpWatcher } from './cdp/watcher.js'
import { LogBuffer } from './buffer/LogBuffer.js'
import { startHttpServer } from './http/server.js'
import { announceWatcher, removeWatcher, startRegistryHeartbeat } from './registry/registry.js'

export type StartWatcherOptions = {
	id: string
	host?: string
	port?: number
	match?: WatcherMatch
	chrome?: WatcherChrome
	bufferSize?: number
	heartbeatMs?: number
}

export type WatcherHandle = {
	close: () => Promise<void>
	watcher: WatcherRecord
}

/**
 * Start a watcher that connects to Chrome CDP, buffers console logs, and exposes the HTTP API.
 * @param options - Configuration for binding, CDP matching, and buffering.
 * @returns A handle that can be closed to stop the watcher and clean up registry state.
 */
export const startWatcher = async (options: StartWatcherOptions): Promise<WatcherHandle> => {
	if (!options.id) {
		throw new Error('Watcher id is required')
	}

	const host = options.host ?? '127.0.0.1'
	const port = options.port ?? 0
	const chrome = options.chrome ?? { host: '127.0.0.1', port: 9222 }
	const bufferSize = options.bufferSize ?? 50_000

	const buffer = new LogBuffer(bufferSize)
	let cdpStatus = { attached: false, target: null as { title: string | null; url: string | null } | null }

	const record: WatcherRecord = {
		id: options.id,
		host,
		port,
		pid: process.pid,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		match: options.match,
		chrome
	}

	const server = await startHttpServer({
		host,
		port,
		buffer,
		getWatcher: () => record,
		getCdpStatus: () => cdpStatus
	})

	record.port = server.port
	await announceWatcher(record)

	const heartbeat = startRegistryHeartbeat(() => record, options.heartbeatMs ?? 15_000)
	const cdp = startCdpWatcher({
		chrome,
		match: options.match,
		onLog: (event) => buffer.add(event),
		onStatus: (status) => {
			cdpStatus = status
		}
	})

	return {
		watcher: record,
		close: async () => {
			heartbeat.stop()
			await cdp.stop()
			await server.close()
			await removeWatcher(record.id)
		}
	}
}

export type { LogEvent }
