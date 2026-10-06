import { createAuthStateOriginUrl, type AuthStateSnapshot } from '@vforsh/argus-core'
import type { PageConsoleLogging } from '@vforsh/argus-core'
import type { WatcherHandle } from '@vforsh/argus-watcher'
import { requestAuthStateSnapshot } from './auth.js'
import { launchChrome, type LaunchChromeResult } from './chromeStart.js'
import { createOutput } from '../output/io.js'
import { formatError } from '../cli/parse.js'
import type { WatcherInjectConfig } from '../config/types.js'
import { buildWatcherMatch, normalizeHttpUrl, registerTerminationHandlers } from './startShared.js'
import { startManagedWatcher } from './watcherSession.js'
import { resolveStartViewport, type StartViewportOptions } from './startViewport.js'
import { waitForStartReady } from './startReadiness.js'
import { announceDetachedStart, startDetached } from './startDetached.js'

export type StartOptions = StartViewportOptions & {
	id: string
	url?: string
	authFrom?: string
	json?: boolean
	detach?: boolean
	profile?: 'temp' | 'default-full' | 'default-medium' | 'default-lite'
	devTools?: boolean
	headless?: boolean
	mute?: boolean
	userAgent?: string
	type?: string
	origin?: string
	target?: string
	parent?: string
	pageIndicator?: boolean
	inject?: WatcherInjectConfig
	artifacts?: string
	pageConsoleLogging?: PageConsoleLogging
}

/** Coordinates returned only after the launched browser and watcher are ready. */
export type StartResult = {
	id: string
	chromePid: number
	cdpHost: string
	cdpPort: number
	watcherHost: string
	watcherPort: number
	watcherPid: number
	/** Isolated profile directory, removed when this session closes. */
	userDataDir: string | null
	userAgentOverride?: true
	/** Persistent stderr log for a detached launcher. */
	launcherLog?: string
}

/** Start a managed browser session, releasing a detached startup channel on every failure path. */
export const runStart = async (options: StartOptions): Promise<void> => {
	try {
		await runStartSession(options)
	} finally {
		if (options.detach && process.connected) process.disconnect?.()
	}
}

const runStartSession = async (options: StartOptions): Promise<void> => {
	const output = createOutput(options)

	if (!options.id || options.id.trim() === '') {
		output.writeWarn('--id is required.')
		process.exitCode = 2
		return
	}

	const watcherId = options.id.trim()
	let viewport: ReturnType<typeof resolveStartViewport>
	try {
		viewport = resolveStartViewport(options)
	} catch (error) {
		output.writeWarn(formatError(error))
		process.exitCode = 2
		return
	}

	if (options.detach && !process.send) {
		try {
			writeStartResult(await startDetached(), options)
		} catch (error) {
			output.writeWarn(formatError(error))
			process.exitCode = 1
		}
		return
	}

	let parentDisconnected = false
	let readyAnnounced = false
	let stop: (() => Promise<void>) | undefined
	if (options.detach) {
		process.once('disconnect', () => {
			if (readyAnnounced) return
			parentDisconnected = true
			void stop?.()
		})
	}
	if (options.authFrom && options.profile && options.profile !== 'temp') {
		output.writeWarn('Cannot combine --auth-from with a copied Chrome profile. Use --profile temp or omit --profile.')
		process.exitCode = 2
		return
	}

	const authState = await resolveStartAuthState(options, output)
	if (!authState) {
		return
	}
	if (parentDisconnected) return

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
			autoPort: true,
			url: authState.startupUrl,
			profile: options.profile,
			devTools: options.devTools,
			headless: options.headless,
			mute: options.mute,
			userAgent: options.userAgent,
			authState: authState.snapshot,
		})
	} catch (error) {
		output.writeWarn(formatError(error))
		process.exitCode = 1
		return
	}
	if (parentDisconnected) {
		await chrome.closeGracefully()
		return
	}

	let handle: WatcherHandle | undefined
	let resolveClosed!: () => void
	const closed = new Promise<void>((resolve) => {
		resolveClosed = resolve
	})
	const shutdown = async () => {
		if (handle) await handle.close()
		else await chrome.closeGracefully()
	}
	stop = shutdown
	registerTerminationHandlers(shutdown)
	chrome.chrome.on('exit', () => {
		void handle?.close()
	})

	authState.startupUrl = chrome.startupUrl

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
		idConflict: 'error',
		source: 'cdp',
		match,
		chrome: { host: chrome.cdpHost, port: chrome.cdpPort },
		pageIndicator: options.pageIndicator,
		artifacts: options.artifacts,
		pageConsoleLogging: options.pageConsoleLogging,
		inject: options.inject,
		emulation: viewport ? { viewport } : undefined,
		onClose: async () => {
			await chrome.closeGracefully()
			if (process.stdin.isTTY) process.stdin.setRawMode(false)
			process.stdin.pause()
			resolveClosed()
		},
	})
	if (!startedWatcher) {
		await chrome.closeGracefully()
		return
	}
	handle = startedWatcher.handle
	if (parentDisconnected || chrome.chrome.exitCode !== null || chrome.chrome.signalCode !== null) {
		await handle.close()
		process.exitCode = 1
		return
	}
	try {
		await waitForStartReady(handle, viewport !== undefined)
	} catch (error) {
		output.writeWarn(formatError(error))
		process.exitCode = 1
		await handle.close()
		return
	}

	// --- Output ---
	const result: StartResult = {
		id: handle.watcher.id,
		chromePid: chrome.chrome.pid!,
		cdpHost: chrome.cdpHost,
		cdpPort: chrome.cdpPort,
		watcherHost: handle.watcher.host,
		watcherPort: handle.watcher.port,
		watcherPid: handle.watcher.pid,
		userDataDir: chrome.userDataDir,
	}
	if (options.userAgent !== undefined) {
		result.userAgentOverride = true
	}

	if (options.detach) {
		try {
			readyAnnounced = true
			await announceDetachedStart(result)
		} catch (error) {
			output.writeWarn(formatError(error))
			process.exitCode = 1
			await handle.close()
			return
		}
	} else {
		writeStartResult(result, options)
	}

	// --- Keyboard shortcut: Q to stop ---
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

	await closed
}

const writeStartResult = (result: StartResult, options: StartOptions): void => {
	const output = createOutput(options)
	if (options.json) {
		output.writeJson(result)
		return
	}
	output.writeHuman(`Watcher attached (id=${result.id}, port=${result.watcherPort})`)
	output.writeHuman(`Chrome pid=${result.chromePid}, cdp=${result.cdpHost}:${result.cdpPort}, watcher pid=${result.watcherPid}`)
	if (options.detach) {
		output.writeHuman(`Running in background. Stop with: argus watcher stop ${result.id}`)
		output.writeHuman(`Launcher log: ${result.launcherLog}`)
		return
	}
	output.writeHuman(`  argus logs ${result.id}`)
	output.writeHuman(`  argus eval ${result.id} "document.title"`)
	output.writeHuman(`  argus screenshot ${result.id}`)
	output.writeHuman('Press Q or Ctrl+C to stop.')
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
