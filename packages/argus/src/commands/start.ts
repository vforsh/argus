import { rmSync } from 'node:fs'
import { startWatcher, type WatcherHandle, type PageConsoleLogging } from '@vforsh/argus-watcher'
import { launchChrome, type LaunchChromeResult } from './chromeStart.js'
import { createOutput } from '../output/io.js'
import type { WatcherInjectConfig } from '../config/argusConfig.js'
import { resolvePath } from '../utils/paths.js'
import { buildWatcherMatch, normalizeHttpUrl, registerTerminationHandlers, resolveInjectScript, waitForever } from './startShared.js'

export type StartOptions = {
	id: string
	url?: string
	json?: boolean
	profile?: 'temp' | 'default-full' | 'default-medium' | 'default-lite'
	devTools?: boolean
	headless?: boolean
	type?: string
	origin?: string
	target?: string
	parent?: string
	pageIndicator?: boolean
	inject?: WatcherInjectConfig
	artifacts?: string
	pageConsoleLogging?: PageConsoleLogging
}

type StartResult = {
	id: string
	chromePid: number
	cdpHost: string
	cdpPort: number
	watcherHost: string
	watcherPort: number
	watcherPid: number
}

export const runStart = async (options: StartOptions): Promise<void> => {
	const output = createOutput(options)

	if (!options.id || options.id.trim() === '') {
		output.writeWarn('--id is required.')
		process.exitCode = 2
		return
	}

	const watcherId = options.id.trim()

	// Resolve startup URL for Chrome (prepend http:// if needed)
	const chromeUrl = normalizeHttpUrl(options.url)

	// At least one targeting option is required for the watcher
	const hasTargeting = options.url?.trim() || options.target?.trim() || options.origin?.trim() || options.type?.trim()
	if (!hasTargeting) {
		output.writeWarn('At least one targeting option is required: --url, --target, --origin, or --type.')
		process.exitCode = 2
		return
	}

	// --- Launch Chrome ---
	if (!options.json) {
		output.writeHuman('Launching Chrome...')
	}

	let chrome: LaunchChromeResult
	try {
		chrome = await launchChrome({
			url: chromeUrl,
			profile: options.profile,
			devTools: options.devTools,
			headless: options.headless,
		})
	} catch (error) {
		output.writeWarn(error instanceof Error ? error.message : String(error))
		process.exitCode = 1
		return
	}

	if (!options.json) {
		output.writeHuman(`Chrome started (pid=${chrome.chrome.pid}, cdp=${chrome.cdpHost}:${chrome.cdpPort})`)
	}

	// --- Start watcher ---
	if (!options.json) {
		output.writeHuman('Attaching watcher...')
	}

	const match = buildWatcherMatch(options)

	let artifactsBaseDir: string | undefined
	if (options.artifacts != null) {
		const trimmed = options.artifacts.trim()
		if (trimmed === '') {
			output.writeWarn('--artifacts must be a non-empty path when provided.')
			chrome.cleanup()
			process.exitCode = 2
			return
		}
		artifactsBaseDir = resolvePath(trimmed)
	}

	const inject = await resolveInjectScript(options.inject, output)

	let handle: WatcherHandle
	try {
		handle = await startWatcher({
			id: watcherId,
			source: 'cdp',
			match,
			chrome: { host: chrome.cdpHost, port: chrome.cdpPort },
			host: '127.0.0.1',
			port: 0,
			net: { enabled: true },
			pageIndicator: options.pageIndicator === false ? { enabled: false } : { enabled: true },
			artifacts: artifactsBaseDir ? { base: artifactsBaseDir } : undefined,
			pageConsoleLogging: options.pageConsoleLogging,
			inject: inject ?? undefined,
		})
	} catch (error) {
		output.writeWarn(`Failed to start watcher: ${error instanceof Error ? error.message : error}`)
		chrome.cleanup()
		process.exitCode = 1
		return
	}

	// --- Cleanup on exit ---
	const shutdown = async () => {
		try {
			await handle.close()
		} catch {}
		await chrome.closeGracefully()
	}

	registerTerminationHandlers(shutdown)

	chrome.chrome.on('exit', () => {
		if (chrome.userDataDir) {
			try {
				rmSync(chrome.userDataDir, { recursive: true, force: true })
			} catch {}
		}
		void handle.close().then(() => process.exit(0))
	})

	// --- CDP events ---
	handle.events.on('cdpAttached', ({ target }) => {
		const typeInfo = target?.type ? ` (type: ${target.type})` : ''
		output.writeHuman(`[${watcherId}] CDP attached: ${target?.title} (${target?.url})${typeInfo}`)
	})

	handle.events.on('cdpDetached', ({ reason, target }) => {
		output.writeHuman(`[${watcherId}] CDP detached: ${reason} (last target: ${target?.title})`)
	})

	// --- Output ---
	const result: StartResult = {
		id: handle.watcher.id,
		chromePid: chrome.chrome.pid!,
		cdpHost: chrome.cdpHost,
		cdpPort: chrome.cdpPort,
		watcherHost: handle.watcher.host,
		watcherPort: handle.watcher.port,
		watcherPid: handle.watcher.pid,
	}

	if (options.json) {
		output.writeJson(result)
	} else {
		output.writeHuman(`Watcher attached (id=${result.id}, port=${result.watcherPort})`)
		output.writeHuman('')
		output.writeHuman(`Ready! Watcher "${result.id}" attached to Chrome.`)
		output.writeHuman(`  argus logs ${result.id}`)
		output.writeHuman(`  argus eval ${result.id} "document.title"`)
		output.writeHuman(`  argus screenshot ${result.id}`)
		output.writeHuman('')
		output.writeHuman('Press Q or Ctrl+C to stop.')
	}

	// --- Keyboard shortcut: X to stop ---
	if (process.stdin.isTTY) {
		process.stdin.setRawMode(true)
		process.stdin.resume()
		process.stdin.setEncoding('utf8')
		process.stdin.on('data', (key: string) => {
			// Ctrl+C in raw mode
			if (key === '\x03') {
				void shutdown().then(() => process.exit(0))
				return
			}
			if (key === 'q' || key === 'Q') {
				output.writeHuman('\nStopping...')
				void shutdown().then(() => process.exit(0))
			}
		})
	}

	await waitForever()
}
