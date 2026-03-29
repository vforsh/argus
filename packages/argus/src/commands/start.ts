import { createAuthStateOriginUrl, type AuthStateSnapshot } from '@vforsh/argus-core'
import { rmSync } from 'node:fs'
import type { PageConsoleLogging } from '@vforsh/argus-watcher'
import { requestAuthStateSnapshot } from './auth.js'
import { applyAuthStateSnapshotToChrome } from './chrome/authState.js'
import { launchChrome, type LaunchChromeResult } from './chromeStart.js'
import { createOutput } from '../output/io.js'
import type { WatcherInjectConfig } from '../config/argusConfig.js'
import { buildWatcherMatch, normalizeHttpUrl, registerTerminationHandlers, waitForever } from './startShared.js'
import { startManagedWatcher } from './watcherSession.js'

export type StartOptions = {
	id: string
	url?: string
	authFrom?: string
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
	if (options.authFrom && options.profile && options.profile !== 'temp') {
		output.writeWarn('Cannot combine --auth-from with a copied Chrome profile. Use --profile temp or omit --profile.')
		process.exitCode = 2
		return
	}

	const authState = await resolveStartAuthState(options, output)
	if (!authState) {
		return
	}

	// At least one targeting option is required for the watcher
	const matchInput = resolveWatcherMatchInput(options, authState.startupUrl)
	const hasTargeting = matchInput.url?.trim() || matchInput.target?.trim() || matchInput.origin?.trim() || matchInput.type?.trim()
	if (!hasTargeting) {
		output.writeWarn('At least one targeting option is required: --url, --auth-from, --target, --origin, or --type.')
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
			url: authState.snapshot ? null : authState.startupUrl,
			profile: authState.snapshot ? 'temp' : options.profile,
			devTools: options.devTools,
			headless: options.headless,
		})
	} catch (error) {
		output.writeWarn(error instanceof Error ? error.message : String(error))
		process.exitCode = 1
		return
	}

	if (authState.snapshot) {
		try {
			const hydrated = await applyAuthStateSnapshotToChrome({
				snapshot: authState.snapshot,
				cdpHost: chrome.cdpHost,
				cdpPort: chrome.cdpPort,
				startupUrl: authState.startupUrl,
			})
			authState.startupUrl = hydrated.startupUrl
		} catch (error) {
			await chrome.closeGracefully()
			output.writeWarn(error instanceof Error ? error.message : String(error))
			process.exitCode = 1
			return
		}
	}

	if (!options.json) {
		output.writeHuman(`Chrome started (pid=${chrome.chrome.pid}, cdp=${chrome.cdpHost}:${chrome.cdpPort})`)
	}

	// --- Start watcher ---
	if (!options.json) {
		output.writeHuman('Attaching watcher...')
	}

	const match = buildWatcherMatch(resolveWatcherMatchInput(options, authState.startupUrl))

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

const resolveStartAuthState = async (
	options: StartOptions,
	output: ReturnType<typeof createOutput>,
): Promise<{ snapshot: AuthStateSnapshot | null; startupUrl: string | null } | null> => {
	const startupUrl = normalizeHttpUrl(options.url)
	if (!options.authFrom) {
		return { snapshot: null, startupUrl }
	}

	const source = await requestAuthStateSnapshot(options.authFrom, {}, output)
	if (!source) {
		return null
	}

	return {
		snapshot: source.data,
		startupUrl: startupUrl ?? resolveSnapshotStartupUrl(source.data),
	}
}

const resolveSnapshotStartupUrl = (snapshot: Pick<AuthStateSnapshot, 'url' | 'origin'>): string | null => {
	if (snapshot.url.trim()) {
		return snapshot.url.trim()
	}
	if (snapshot.origin.trim()) {
		return createAuthStateOriginUrl(snapshot.origin)
	}
	return null
}

const resolveWatcherMatchInput = (options: StartOptions, startupUrl: string | null): StartOptions => ({
	...options,
	url: options.url ?? startupUrl ?? undefined,
})
