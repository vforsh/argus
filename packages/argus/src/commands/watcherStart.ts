import type { PageConsoleLogging, WatcherSourceMode } from '@vforsh/argus-watcher'
import crypto from 'node:crypto'
import { createOutput } from '../output/io.js'
import type { WatcherInjectConfig } from '../config/argusConfig.js'
import { buildWatcherMatch, registerTerminationHandlers, waitForever } from './startShared.js'
import { startManagedWatcher } from './watcherSession.js'

export type WatcherStartOptions = {
	id?: string
	/** Source mode for CDP connection: 'cdp' (default) or 'extension'. */
	source?: WatcherSourceMode
	url?: string
	json?: boolean
	chromeHost?: string
	chromePort?: string | number
	pageIndicator?: boolean
	artifacts?: string
	pageConsoleLogging?: PageConsoleLogging
	/** JavaScript injection on watcher attach. */
	inject?: WatcherInjectConfig
	/** Filter by target type (e.g., 'page', 'iframe'). */
	type?: string
	/** Match against URL origin only (protocol + host + port). */
	origin?: string
	/** Connect to a specific target by its Chrome target ID. */
	target?: string
	/** Filter by parent target URL pattern. */
	parent?: string
}

type WatcherStartResult = {
	id: string
	host: string
	port: number
	pid: number
	source: WatcherSourceMode
	matchUrl?: string
	matchType?: string
	matchOrigin?: string
	matchTarget?: string
	matchParent?: string
	chromeHost?: string
	chromePort?: number
	artifactsBaseDir?: string
}

const isValidPort = (port: number): boolean => Number.isFinite(port) && port >= 1 && port <= 65535

const parsePort = (value: string | number): number | null => {
	const port = typeof value === 'string' ? parseInt(value, 10) : value
	return isValidPort(port) ? port : null
}

export const runWatcherStart = async (options: WatcherStartOptions): Promise<void> => {
	const output = createOutput(options)

	// Validate source option
	const sourceMode: WatcherSourceMode = options.source ?? 'cdp'
	if (sourceMode !== 'cdp' && sourceMode !== 'extension') {
		output.writeWarn(`Invalid --source: ${options.source}. Must be 'cdp' or 'extension'.`)
		process.exitCode = 2
		return
	}

	// For extension mode, validate that CDP targeting options are not used
	// (chrome-host/chrome-port are ignored but allowed for config file compatibility)
	if (sourceMode === 'extension') {
		const cdpTargetingOptions = []
		if (options.url?.trim()) cdpTargetingOptions.push('--url')
		if (options.target?.trim()) cdpTargetingOptions.push('--target')
		if (options.origin?.trim()) cdpTargetingOptions.push('--origin')
		if (options.type?.trim()) cdpTargetingOptions.push('--type')
		if (options.parent?.trim()) cdpTargetingOptions.push('--parent')

		if (cdpTargetingOptions.length > 0) {
			output.writeWarn(`CDP targeting options cannot be used with --source extension: ${cdpTargetingOptions.join(', ')}`)
			process.exitCode = 2
			return
		}
	}

	// For CDP mode, at least one targeting option is required
	if (sourceMode === 'cdp') {
		const hasTargeting = options.url?.trim() || options.target?.trim() || options.origin?.trim() || options.type?.trim()
		if (!hasTargeting) {
			output.writeWarn('At least one targeting option is required for CDP mode: --url, --target, --origin, or --type.')
			process.exitCode = 2
			return
		}
	}

	let chromeHost: string | undefined
	let chromePort: number | undefined
	if (sourceMode === 'cdp') {
		chromeHost = options.chromeHost?.trim() || '127.0.0.1'
		chromePort = 9222
		if (options.chromePort != null) {
			const parsed = parsePort(options.chromePort)
			if (parsed === null) {
				output.writeWarn(`Invalid --chrome-port: ${options.chromePort}. Must be an integer 1-65535.`)
				process.exitCode = 2
				return
			}
			chromePort = parsed
		}
	}

	const watcherId = options.id?.trim() || generateWatcherId()
	const match = sourceMode === 'cdp' ? buildWatcherMatch(options) : undefined

	const startedWatcher = await startManagedWatcher({
		output,
		watcherId,
		source: sourceMode,
		match,
		chrome: sourceMode === 'cdp' ? { host: chromeHost!, port: chromePort! } : undefined,
		pageIndicator: options.pageIndicator,
		artifacts: options.artifacts,
		pageConsoleLogging: options.pageConsoleLogging,
		inject: options.inject,
	})
	if (!startedWatcher) {
		return
	}
	const { handle, artifactsBaseDir } = startedWatcher

	const result: WatcherStartResult = {
		id: handle.watcher.id,
		host: handle.watcher.host,
		port: handle.watcher.port,
		pid: handle.watcher.pid,
		source: sourceMode,
		matchUrl: match?.url,
		matchType: match?.type,
		matchOrigin: match?.origin,
		matchTarget: match?.targetId,
		matchParent: match?.parent,
		chromeHost,
		chromePort,
		artifactsBaseDir,
	}

	const cleanup = async () => {
		try {
			await handle.close()
		} catch {}
	}

	registerTerminationHandlers(cleanup)

	if (options.json) {
		output.writeJson(result)
	} else {
		output.writeHuman(`Watcher started:`)
		output.writeHuman(`  id=${result.id}`)
		output.writeHuman(`  source=${result.source}`)
		output.writeHuman(`  host=${result.host}`)
		output.writeHuman(`  port=${result.port}`)
		if (result.matchUrl) {
			output.writeHuman(`  matchUrl=${result.matchUrl}`)
		}
		if (result.matchType) {
			output.writeHuman(`  matchType=${result.matchType}`)
		}
		if (result.matchOrigin) {
			output.writeHuman(`  matchOrigin=${result.matchOrigin}`)
		}
		if (result.matchTarget) {
			output.writeHuman(`  matchTarget=${result.matchTarget}`)
		}
		if (result.matchParent) {
			output.writeHuman(`  matchParent=${result.matchParent}`)
		}
		if (result.chromeHost && result.chromePort) {
			output.writeHuman(`  chrome=${result.chromeHost}:${result.chromePort}`)
		}
		if (result.artifactsBaseDir) {
			output.writeHuman(`  artifacts=${result.artifactsBaseDir}`)
		}
	}

	await waitForever()
}

/** Generate a short random watcher ID (e.g. "a3f1b2"). */
const generateWatcherId = (): string => crypto.randomBytes(3).toString('hex')
