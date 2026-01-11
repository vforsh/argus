import type { WatcherMatch, WatcherChrome, WatcherRecord, LogEvent } from '@vforsh/argus-core'
import path from 'node:path'
import { startCdpWatcher } from './cdp/watcher.js'
import { LogBuffer } from './buffer/LogBuffer.js'
import { startHttpServer } from './http/server.js'
import { announceWatcher, removeWatcher, startRegistryHeartbeat } from './registry/registry.js'
import { WatcherFileLogger } from './fileLogs/WatcherFileLogger.js'
import { buildIgnoreMatcher } from './cdp/ignoreList.js'

/** Options to start a watcher server. */
export type StartWatcherOptions = {
	/** Unique watcher identifier (used for registry presence and removal on shutdown). */
	id: string
	/** Host/interface to bind the watcher HTTP server to. Defaults to `127.0.0.1`. */
	host?: string
	/** Port to bind the watcher HTTP server to. Defaults to `0` (ephemeral). */
	port?: number
	/** Criteria for which Chrome target(s) to attach to. */
	match?: WatcherMatch
	/** Chrome DevTools Protocol (CDP) connection settings. Defaults to `127.0.0.1:9222`. */
	chrome?: WatcherChrome
	/** Max buffered log events before older entries are dropped. Defaults to `50_000`. */
	bufferSize?: number
	/** How often (in ms) to refresh the watcher record in the registry. Defaults to `15_000`. */
	heartbeatMs?: number
	/** Optional file log persistence settings. */
	fileLogs?: {
		/** Directory to store watcher logs. Required when fileLogs is set. */
		logsDir: string
		/** Max number of log files to keep for this watcher. Defaults to `5`. */
		maxFiles?: number
	}
	/** Optional ignore list filtering when selecting log/exception locations. */
	ignoreList?: {
		/** Enable ignore list filtering for log/exception locations. */
		enabled?: boolean
		/** Regex patterns (as strings) to ignore when selecting a stack frame. */
		rules?: string[]
	}
	/** Whether to include ISO timestamps in log records. Defaults to `false`. */
	includeTimestamps?: boolean
	location?: {
		/**
		 * Strip these literal prefixes from event.file for display/logging.
		 * This is cosmetic and does not affect sourcemap resolution.
		 */
		stripUrlPrefixes?: string[]
	}
}

/** Handle returned by startWatcher. */
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
	const startedAt = Date.now()
	const includeTimestamps = options.includeTimestamps ?? false
	const ignoreMatcher = buildIgnoreMatcher(options.ignoreList)
	const stripUrlPrefixes = options.location?.stripUrlPrefixes

	const buffer = new LogBuffer(bufferSize)
	let cdpStatus = { attached: false, target: null as { title: string | null; url: string | null } | null }
	const fileLogs = options.fileLogs
	const logsDir = fileLogs ? resolveLogsDir(fileLogs.logsDir) : null
	const maxFiles = fileLogs ? resolveMaxFiles(fileLogs.maxFiles) : null
	const fileLogger = logsDir
		? new WatcherFileLogger({
				watcherId: options.id,
				startedAt,
				logsDir,
				chrome,
				match: options.match,
				maxFiles: maxFiles ?? 5,
				includeTimestamps,
			})
		: null

	const record: WatcherRecord = {
		id: options.id,
		host,
		port,
		pid: process.pid,
		startedAt,
		updatedAt: Date.now(),
		match: options.match,
		chrome,
		includeTimestamps,
	}

	const server = await startHttpServer({
		host,
		port,
		buffer,
		getWatcher: () => record,
		getCdpStatus: () => cdpStatus,
	})

	record.port = server.port
	await announceWatcher(record)

	const heartbeat = startRegistryHeartbeat(() => record, options.heartbeatMs ?? 15_000)
	const cdp = startCdpWatcher({
		chrome,
		match: options.match,
		ignoreMatcher,
		stripUrlPrefixes,
		onLog: (event) => {
			buffer.add(event)
			fileLogger?.writeEvent(event)
		},
		onPageNavigation: (info) => {
			fileLogger?.rotate(info)
		},
		onPageIntl: (info) => {
			fileLogger?.setPageIntl(info)
		},
		onStatus: (status) => {
			cdpStatus = status
		},
	})

	return {
		watcher: record,
		close: async () => {
			heartbeat.stop()
			await cdp.stop()
			await fileLogger?.close()
			await server.close()
			await removeWatcher(record.id)
		},
	}
}

/** Log event shape emitted by watchers. */
export type { LogEvent }

const resolveLogsDir = (logsDir: string): string => {
	if (typeof logsDir !== 'string' || logsDir.trim() === '') {
		throw new Error('fileLogs.logsDir is required')
	}
	return path.resolve(logsDir)
}

const resolveMaxFiles = (maxFiles?: number): number => {
	if (maxFiles === undefined) {
		return 5
	}
	if (!Number.isInteger(maxFiles) || maxFiles < 1) {
		throw new Error('fileLogs.maxFiles must be an integer >= 1')
	}
	return maxFiles
}
