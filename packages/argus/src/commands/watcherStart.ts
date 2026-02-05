import { startWatcher, type WatcherHandle, type PageConsoleLogging, type WatcherSourceMode } from '@vforsh/argus-watcher'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createOutput } from '../output/io.js'
import type { WatcherInjectConfig } from '../config/argusConfig.js'

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

const resolveInjectScript = async (
	inject: WatcherInjectConfig | undefined,
	output: { writeWarn: (message: string) => void },
): Promise<{ script: string; exposeArgus?: boolean } | null> => {
	if (!inject) {
		return null
	}

	const resolvedPath = path.isAbsolute(inject.file) ? inject.file : path.resolve(process.cwd(), inject.file)
	let script: string
	try {
		script = await fs.readFile(resolvedPath, 'utf8')
	} catch (error) {
		output.writeWarn(
			`Failed to read inject script at ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}. Skipping injection.`,
		)
		return null
	}

	if (script.trim() === '') {
		output.writeWarn(`Inject script at ${resolvedPath} is empty. Skipping injection.`)
		return null
	}

	return { script, exposeArgus: inject.exposeArgus }
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
	const matchUrl = options.url?.trim()
	let artifactsBaseDir: string | undefined
	if (options.artifacts != null) {
		const trimmed = options.artifacts.trim()
		if (trimmed === '') {
			output.writeWarn('--artifacts must be a non-empty path when provided.')
			process.exitCode = 2
			return
		}
		artifactsBaseDir = path.resolve(process.cwd(), trimmed)
	}

	const inject = await resolveInjectScript(options.inject, output)

	// Build the match object from various filter options
	const match: {
		url?: string
		type?: string
		origin?: string
		targetId?: string
		parent?: string
	} = {}

	if (matchUrl) {
		match.url = matchUrl
	}
	if (options.type?.trim()) {
		match.type = options.type.trim()
	}
	if (options.origin?.trim()) {
		match.origin = options.origin.trim()
	}
	if (options.target?.trim()) {
		match.targetId = options.target.trim()
	}
	if (options.parent?.trim()) {
		match.parent = options.parent.trim()
	}

	let handle: WatcherHandle
	try {
		handle = await startWatcher({
			id: watcherId,
			source: sourceMode,
			match: sourceMode === 'cdp' && Object.keys(match).length > 0 ? match : undefined,
			chrome: sourceMode === 'cdp' ? { host: chromeHost!, port: chromePort! } : undefined,
			host: '127.0.0.1',
			port: 0,
			pageIndicator: sourceMode === 'cdp' ? (options.pageIndicator === false ? { enabled: false } : { enabled: true }) : { enabled: false },
			artifacts: artifactsBaseDir ? { base: artifactsBaseDir } : undefined,
			pageConsoleLogging: options.pageConsoleLogging,
			inject: inject ?? undefined,
		})
	} catch (error) {
		output.writeWarn(`Failed to start watcher: ${error instanceof Error ? error.message : error}`)
		process.exitCode = 1
		return
	}

	const result: WatcherStartResult = {
		id: handle.watcher.id,
		host: handle.watcher.host,
		port: handle.watcher.port,
		pid: handle.watcher.pid,
		source: sourceMode,
		matchUrl: match.url,
		matchType: match.type,
		matchOrigin: match.origin,
		matchTarget: match.targetId,
		matchParent: match.parent,
		chromeHost,
		chromePort,
		artifactsBaseDir,
	}

	const cleanup = async () => {
		try {
			await handle.close()
		} catch {}
	}

	process.on('SIGINT', () => {
		void cleanup().then(() => process.exit(0))
	})
	process.on('SIGTERM', () => {
		void cleanup().then(() => process.exit(0))
	})

	handle.events.on('cdpAttached', ({ target }) => {
		const typeInfo = target?.type ? ` (type: ${target.type})` : ''
		output.writeHuman(`[${handle.watcher.id}] CDP attached: ${target?.title} (${target?.url})${typeInfo}`)
	})

	handle.events.on('cdpDetached', ({ reason, target }) => {
		output.writeHuman(`[${handle.watcher.id}] CDP detached: ${reason} (last target: ${target?.title})`)
	})

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

	await new Promise(() => {})
}

/** Generate a short random watcher ID (e.g. "a3f1b2"). */
const generateWatcherId = (): string => crypto.randomBytes(3).toString('hex')
