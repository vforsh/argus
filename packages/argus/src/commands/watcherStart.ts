import { startWatcher, type WatcherHandle } from '@vforsh/argus-watcher'
import path from 'node:path'
import { createOutput } from '../output/io.js'

export type WatcherStartOptions = {
	id?: string
	url?: string
	json?: boolean
	chromeHost?: string
	chromePort?: string | number
	pageIndicator?: boolean
	artifacts?: string
}

type WatcherStartResult = {
	id: string
	host: string
	port: number
	pid: number
	matchUrl: string
	chromeHost: string
	chromePort: number
	artifactsBaseDir?: string
}

const isValidPort = (port: number): boolean => Number.isFinite(port) && port >= 1 && port <= 65535

const parsePort = (value: string | number): number | null => {
	const port = typeof value === 'string' ? parseInt(value, 10) : value
	return isValidPort(port) ? port : null
}

export const runWatcherStart = async (options: WatcherStartOptions): Promise<void> => {
	const output = createOutput(options)
	if (!options.id || options.id.trim() === '') {
		output.writeWarn('--id is required.')
		process.exitCode = 2
		return
	}

	if (!options.url || options.url.trim() === '') {
		output.writeWarn('--url is required.')
		process.exitCode = 2
		return
	}

	const chromeHost = options.chromeHost?.trim() || '127.0.0.1'
	let chromePort = 9222
	if (options.chromePort != null) {
		const parsed = parsePort(options.chromePort)
		if (parsed === null) {
			output.writeWarn(`Invalid --chrome-port: ${options.chromePort}. Must be an integer 1-65535.`)
			process.exitCode = 2
			return
		}
		chromePort = parsed
	}

	const watcherId = options.id.trim()
	const matchUrl = options.url.trim()
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

	let handle: WatcherHandle
	try {
		handle = await startWatcher({
			id: watcherId,
			match: { url: matchUrl },
			chrome: { host: chromeHost, port: chromePort },
			host: '127.0.0.1',
			port: 0,
			pageIndicator: options.pageIndicator === false ? { enabled: false } : { enabled: true },
			artifacts: artifactsBaseDir ? { base: artifactsBaseDir } : undefined,
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
		matchUrl,
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
		output.writeHuman(`[${handle.watcher.id}] CDP attached: ${target?.title} (${target?.url})`)
	})

	handle.events.on('cdpDetached', ({ reason, target }) => {
		output.writeHuman(`[${handle.watcher.id}] CDP detached: ${reason} (last target: ${target?.title})`)
	})

	if (options.json) {
		output.writeJson(result)
	} else {
		output.writeHuman(`Watcher started:`)
		output.writeHuman(`  id=${result.id}`)
		output.writeHuman(`  host=${result.host}`)
		output.writeHuman(`  port=${result.port}`)
		output.writeHuman(`  matchUrl=${result.matchUrl}`)
		output.writeHuman(`  chrome=${result.chromeHost}:${result.chromePort}`)
		if (result.artifactsBaseDir) {
			output.writeHuman(`  artifacts=${result.artifactsBaseDir}`)
		}
	}

	await new Promise(() => {})
}
