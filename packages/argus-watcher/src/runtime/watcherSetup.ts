import type { WatcherChrome, WatcherRecord } from '@vforsh/argus-core'
import os from 'node:os'
import path from 'node:path'
import Emittery from 'emittery'
import { LogBuffer } from '../buffer/LogBuffer.js'
import { NetBuffer } from '../buffer/NetBuffer.js'
import { WatcherFileLogger } from '../fileLogs/WatcherFileLogger.js'
import { buildIgnoreMatcher } from '../cdp/ignoreList.js'
import { createCdpSessionHandle } from '../cdp/connection.js'
import { createEmulationController } from '../emulation/EmulationController.js'
import { createThrottleController } from '../throttle/ThrottleController.js'
import { createVisibilityController } from '../visibility/VisibilityController.js'
import type { ArgusWatcherEventMap } from '../events.js'
import type { StartWatcherOptions } from '../index.js'

export type NormalizedWatcherSetup = {
	sourceMode: NonNullable<StartWatcherOptions['source']>
	host: string
	port: number
	chrome: WatcherChrome
	watcherId: string
	startedAt: number
	artifactsBaseDir: string
	includeTimestamps: boolean
	netEnabled: boolean
	pageConsoleLogging: NonNullable<StartWatcherOptions['pageConsoleLogging']>
	ignoreMatcher: ReturnType<typeof buildIgnoreMatcher>
	stripUrlPrefixes: string[] | undefined
	events: Emittery<ArgusWatcherEventMap>
	buffer: LogBuffer
	netBuffer: NetBuffer | null
	record: WatcherRecord
	fileLogger: WatcherFileLogger | null
	sessionHandle: ReturnType<typeof createCdpSessionHandle>
	emulationController: ReturnType<typeof createEmulationController>
	throttleController: ReturnType<typeof createThrottleController>
	visibilityController: ReturnType<typeof createVisibilityController>
}

export const normalizeWatcherSetup = (options: StartWatcherOptions, watcherId: string): NormalizedWatcherSetup => {
	const sourceMode = options.source ?? 'cdp'
	const host = options.host ?? '127.0.0.1'
	const port = options.port ?? 0
	const chrome = options.chrome ?? { host: '127.0.0.1', port: 9222 }
	const bufferSize = options.bufferSize ?? 50_000
	const startedAt = Date.now()
	const ignoreMatcher = buildIgnoreMatcher(options.ignoreList)
	const stripUrlPrefixes = options.location?.stripUrlPrefixes
	const artifactsBaseDir = resolveArtifactsBaseDir(options.artifacts?.base, watcherId)
	const logsEnabled = options.artifacts?.logs?.enabled === true
	const logsDir = path.join(artifactsBaseDir, 'logs')
	const includeTimestamps = options.artifacts?.logs?.includeTimestamps ?? false
	const maxFiles = resolveMaxFiles(options.artifacts?.logs?.maxFiles)
	const netEnabled = options.net?.enabled === true
	const pageConsoleLogging = options.pageConsoleLogging ?? 'minimal'
	const events = new Emittery<ArgusWatcherEventMap>()
	const buffer = new LogBuffer(bufferSize)
	const netBuffer = netEnabled ? new NetBuffer(bufferSize) : null
	const fileLogger = logsEnabled
		? new WatcherFileLogger({
				watcherId,
				startedAt,
				logsDir,
				chrome: sourceMode === 'cdp' ? chrome : undefined,
				match: options.match,
				maxFiles,
				includeTimestamps,
				buildFilename: options.artifacts?.logs?.buildFilename,
			})
		: null
	const record: WatcherRecord = {
		id: watcherId,
		host,
		port,
		pid: process.pid,
		cwd: process.cwd(),
		startedAt,
		updatedAt: Date.now(),
		match: sourceMode === 'cdp' ? options.match : undefined,
		chrome: sourceMode === 'cdp' ? chrome : undefined,
		includeTimestamps,
		source: sourceMode,
	}

	return {
		sourceMode,
		host,
		port,
		chrome,
		watcherId,
		startedAt,
		artifactsBaseDir,
		includeTimestamps,
		netEnabled,
		pageConsoleLogging,
		ignoreMatcher,
		stripUrlPrefixes,
		events,
		buffer,
		netBuffer,
		record,
		fileLogger,
		sessionHandle: createCdpSessionHandle(),
		emulationController: createEmulationController(),
		throttleController: createThrottleController(),
		visibilityController: createVisibilityController(),
	}
}

const resolveArtifactsBaseDir = (base: string | undefined, watcherId: string): string => {
	if (base !== undefined && base !== null) {
		if (typeof base !== 'string' || base.trim() === '') {
			throw new Error('artifacts.base must be a non-empty string when provided')
		}
		return path.resolve(base)
	}
	return path.join(os.tmpdir(), 'argus', watcherId)
}

const resolveMaxFiles = (maxFiles?: number): number => {
	if (maxFiles === undefined) {
		return 5
	}
	if (!Number.isInteger(maxFiles) || maxFiles < 1) {
		throw new Error('artifacts.logs.maxFiles must be an integer >= 1')
	}
	return maxFiles
}
