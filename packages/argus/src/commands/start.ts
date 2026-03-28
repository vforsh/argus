import { rmSync } from 'node:fs'
import type { PageConsoleLogging } from '@vforsh/argus-watcher'
import { launchChrome, type LaunchChromeResult } from './chromeStart.js'
import { createOutput } from '../output/io.js'
import type { WatcherInjectConfig } from '../config/argusConfig.js'
import { buildWatcherMatch, normalizeHttpUrl, registerTerminationHandlers, waitForever } from './startShared.js'
import { startManagedWatcher } from './watcherSession.js'

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

	const startedWatcher = await startManagedWatcher({
		output,
		watcherId,
		source: 'cdp',
		match,
		chrome: { host: chrome.cdpHost, port: chrome.cdpPort },
		pageIndicator: options.pageIndicator,
		artifacts: options.artifacts,
		pageConsoleLogging: options.pageConsoleLogging,
		inject: options.inject,
	})
	if (!startedWatcher) {
		chrome.cleanup()
		return
	}
	const { handle } = startedWatcher

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
