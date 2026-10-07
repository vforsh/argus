import { spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { loadActiveRegistry } from '../registry.js'
import { createOutput } from '../output/io.js'
import { formatError } from '../cli/parse.js'
import { resolveChromeBin } from '../utils/chromeBin.js'
import { getCdpPort } from '../utils/ports.js'
import { normalizeHttpUrl, registerTerminationHandlers, waitForever } from './startShared.js'
import type { AuthStateSnapshot } from '@vforsh/argus-core'
import { applyAuthStateSnapshotToChrome } from './chrome/authState.js'
import { loadAuthStateSnapshot } from './auth.js'
import { buildChromeLaunchArgs } from './chrome/launchArgs.js'
import { resolveChromeUserAgent } from './chrome/userAgent.js'
import { createChromeCleanup } from './chrome/lifecycle.js'
import { waitForLaunchedChrome } from './chrome/readiness.js'

export type ChromeStartOptions = {
	url?: string
	fromWatcher?: string
	json?: boolean
	profile?: 'temp' | 'default-full' | 'default-medium' | 'default-lite'
	devTools?: boolean
	headless?: boolean
	mute?: boolean
	userAgent?: string
	authState?: string
}

type ChromeStartResult = {
	chromePid: number
	cdpHost: string
	cdpPort: number
	userDataDir: string | null
	startupUrl: string | null
	userAgentOverride?: true
}

export type LaunchChromeOptions = {
	/** Let Chrome allocate its CDP port atomically. Use for concurrent managed sessions; default prefers 9222. */
	autoPort?: boolean
	url?: string | null
	profile?: 'temp' | 'default-full' | 'default-medium' | 'default-lite'
	devTools?: boolean
	headless?: boolean
	mute?: boolean
	userAgent?: string
	/**
	 * Hydrate this saved auth state into the fresh profile before returning.
	 *
	 * Hydration owns the first navigation, so Chrome starts with no URL and the returned
	 * `startupUrl` is the hydrated one. Forces a temp profile — hydrating into the user's real
	 * profile would write their cookies there. A hydration failure closes Chrome before throwing,
	 * so a caller never inherits a browser it has no handle for.
	 */
	authState?: AuthStateSnapshot | null
}

export type LaunchChromeResult = {
	chrome: ChildProcess
	cdpHost: string
	cdpPort: number
	userDataDir: string | null
	startupUrl: string | null
	/** Kill Chrome and remove temp profile. Use `closeGracefully` when possible. */
	cleanup: () => void
	/** Send Browser.close via CDP, wait for exit, then remove temp profile. Falls back to kill. */
	closeGracefully: () => Promise<void>
}

const resolveChromeUserDataDir = (): string | null => {
	if (process.env.ARGUS_CHROME_USER_DATA_DIR) {
		const override = process.env.ARGUS_CHROME_USER_DATA_DIR.trim()
		if (override && existsSync(override)) {
			return override
		}
	}

	const platform = process.platform
	if (platform === 'darwin') {
		const candidates = [
			path.join(homedir(), 'Library/Application Support/Google/Chrome'),
			path.join(homedir(), 'Library/Application Support/Chromium'),
		]
		return candidates.find((candidate) => existsSync(candidate)) ?? null
	}

	if (platform === 'linux') {
		const candidates = [path.join(homedir(), '.config/google-chrome'), path.join(homedir(), '.config/chromium')]
		return candidates.find((candidate) => existsSync(candidate)) ?? null
	}

	if (platform === 'win32') {
		const base = process.env.LOCALAPPDATA
		if (!base) {
			return null
		}
		const candidates = [path.join(base, 'Google/Chrome/User Data'), path.join(base, 'Chromium/User Data')]
		return candidates.find((candidate) => existsSync(candidate)) ?? null
	}

	return null
}

const copyDefaultProfile = (sourceDir: string): string => {
	const destRoot = mkdtempSync(path.join(tmpdir(), 'argus-chrome-profile-'))
	mkdirSync(destRoot, { recursive: true })

	const entries = ['Default', 'Local State', 'First Run', 'Last Version']
	for (const entry of entries) {
		const source = path.join(sourceDir, entry)
		if (!existsSync(source)) {
			continue
		}
		const dest = path.join(destRoot, entry)
		if (entry === 'Default') {
			cpSync(source, dest, { recursive: true })
		} else {
			copyFileSync(source, dest)
		}
	}

	return destRoot
}

const stripExtensionsFromPrefs = (prefsPath: string): void => {
	if (!existsSync(prefsPath)) {
		return
	}
	try {
		const raw = readFileSync(prefsPath, 'utf-8')
		const prefs = JSON.parse(raw)
		delete prefs.extensions
		writeFileSync(prefsPath, JSON.stringify(prefs))
	} catch {
		// Unparseable — leave as-is
	}
}

const copyDefaultProfileLite = (sourceDir: string): string => {
	const destRoot = mkdtempSync(path.join(tmpdir(), 'argus-chrome-profile-lite-'))
	const defaultDir = path.join(destRoot, 'Default')
	mkdirSync(defaultDir, { recursive: true })

	const copyIfExists = (source: string, dest: string): void => {
		if (!existsSync(source)) {
			return
		}
		copyFileSync(source, dest)
	}

	copyIfExists(path.join(sourceDir, 'Local State'), path.join(destRoot, 'Local State'))
	copyIfExists(path.join(sourceDir, 'Default', 'Cookies'), path.join(defaultDir, 'Cookies'))
	copyIfExists(path.join(sourceDir, 'Default', 'Cookies-journal'), path.join(defaultDir, 'Cookies-journal'))
	copyIfExists(path.join(sourceDir, 'Default', 'Login Data'), path.join(defaultDir, 'Login Data'))
	copyIfExists(path.join(sourceDir, 'Default', 'Login Data-journal'), path.join(defaultDir, 'Login Data-journal'))
	copyIfExists(path.join(sourceDir, 'Default', 'Preferences'), path.join(defaultDir, 'Preferences'))
	copyIfExists(path.join(sourceDir, 'Default', 'Secure Preferences'), path.join(defaultDir, 'Secure Preferences'))

	stripExtensionsFromPrefs(path.join(defaultDir, 'Preferences'))
	stripExtensionsFromPrefs(path.join(defaultDir, 'Secure Preferences'))

	return destRoot
}

const copyDefaultProfileMedium = (sourceDir: string): string => {
	const destRoot = copyDefaultProfileLite(sourceDir)
	const defaultDir = path.join(destRoot, 'Default')

	const copyPathIfExists = (source: string, dest: string): void => {
		if (!existsSync(source)) {
			return
		}
		const stats = statSync(source)
		if (stats.isDirectory()) {
			cpSync(source, dest, { recursive: true })
			return
		}
		copyFileSync(source, dest)
	}

	copyPathIfExists(path.join(sourceDir, 'Default', 'History'), path.join(defaultDir, 'History'))
	copyPathIfExists(path.join(sourceDir, 'Default', 'Local Storage'), path.join(defaultDir, 'Local Storage'))
	copyPathIfExists(path.join(sourceDir, 'Default', 'IndexedDB'), path.join(defaultDir, 'IndexedDB'))

	return destRoot
}

const normalizeProfile = (profile?: string): ChromeStartOptions['profile'] | null => {
	if (!profile) {
		return 'default-lite'
	}
	const trimmed = profile.trim()
	if (trimmed === '') {
		return 'default-lite'
	}
	if (trimmed === 'temp' || trimmed === 'default-full' || trimmed === 'default-medium' || trimmed === 'default-lite') {
		return trimmed
	}
	return null
}

/**
 * Launch Chrome with CDP enabled. Returns a handle with the child process,
 * CDP coordinates, and a cleanup function. Throws on failure.
 */
export const launchChrome = async (options: LaunchChromeOptions): Promise<LaunchChromeResult> => {
	const profile = normalizeProfile(options.authState ? 'temp' : options.profile)
	if (!profile) {
		throw new Error('Invalid --profile value. Use temp, default-full, default-medium, or default-lite.')
	}

	// Hydration performs the first navigation itself, so Chrome must not open the URL as well.
	const startupUrl = options.url ?? null
	const launchUrl = options.authState ? null : startupUrl

	const chromeBin = resolveChromeBin()
	if (!chromeBin) {
		throw new Error('Chrome executable not found. Set ARGUS_CHROME_BIN environment variable.')
	}
	const userAgent = await resolveChromeUserAgent(chromeBin, options.userAgent)

	let userDataDir: string | null = null
	if (profile !== 'temp') {
		const sourceDir = resolveChromeUserDataDir()
		if (!sourceDir) {
			throw new Error('Chrome user data dir not found. Set ARGUS_CHROME_USER_DATA_DIR.')
		}
		if (profile === 'default-lite') {
			userDataDir = copyDefaultProfileLite(sourceDir)
		} else if (profile === 'default-medium') {
			userDataDir = copyDefaultProfileMedium(sourceDir)
		} else {
			userDataDir = copyDefaultProfile(sourceDir)
		}
	}

	let cdpPort = options.autoPort ? 0 : await getCdpPort()
	const cdpHost = '127.0.0.1'
	if (!userDataDir) {
		userDataDir = mkdtempSync(path.join(tmpdir(), 'argus-chrome-'))
	}

	const cleanupDir = () => {
		if (userDataDir) {
			try {
				rmSync(userDataDir, { recursive: true, force: true })
			} catch {}
		}
	}

	const args = buildChromeLaunchArgs({
		cdpPort,
		userDataDir,
		devTools: options.devTools,
		headless: options.headless,
		mute: options.mute,
		userAgent: userAgent ?? undefined,
		launchUrl,
	})

	let chrome: ChildProcess
	try {
		chrome = spawn(chromeBin, args, {
			stdio: 'ignore',
			detached: false,
		})
	} catch (error) {
		cleanupDir()
		throw new Error(`Failed to spawn Chrome: ${formatError(error)}`)
	}

	if (!chrome.pid) {
		cleanupDir()
		throw new Error('Failed to start Chrome: no PID returned.')
	}

	let browserWebSocketUrl: string
	try {
		const ready = await waitForLaunchedChrome(chrome, { host: cdpHost, port: cdpPort }, userDataDir)
		cdpPort = ready.port
		browserWebSocketUrl = ready.version.webSocketDebuggerUrl
	} catch (error) {
		await createChromeCleanup(chrome, undefined, cleanupDir).closeGracefully()
		throw new Error(`Chrome started but CDP is unavailable. Reason: ${formatError(error)}`)
	}
	const { cleanup, closeGracefully } = createChromeCleanup(chrome, browserWebSocketUrl, cleanupDir)

	const resolvedStartupUrl = options.authState
		? (await hydrateAuthState(options.authState, { cdpHost, cdpPort, startupUrl, closeGracefully })).startupUrl
		: startupUrl

	return { chrome, cdpHost, cdpPort, userDataDir, startupUrl: resolvedStartupUrl, cleanup, closeGracefully }
}

/** Apply a snapshot to the freshly launched browser, closing it if hydration fails. */
const hydrateAuthState = async (
	snapshot: AuthStateSnapshot,
	context: { cdpHost: string; cdpPort: number; startupUrl: string | null; closeGracefully: () => Promise<void> },
): Promise<{ startupUrl: string | null }> => {
	try {
		return await applyAuthStateSnapshotToChrome({
			snapshot,
			cdpHost: context.cdpHost,
			cdpPort: context.cdpPort,
			startupUrl: context.startupUrl,
		})
	} catch (error) {
		await context.closeGracefully()
		throw error
	}
}

export const runChromeStart = async (options: ChromeStartOptions): Promise<void> => {
	const output = createOutput(options)
	if (options.url && options.fromWatcher) {
		output.writeWarn('Cannot combine --url with --from-watcher. Use one or the other.')
		process.exitCode = 2
		return
	}

	let startupUrl: string | null = null

	if (options.fromWatcher) {
		const registry = await loadActiveRegistry()
		const watcher = registry.watchers[options.fromWatcher]
		if (!watcher) {
			output.writeWarn(`Watcher not found: ${options.fromWatcher}`)
			process.exitCode = 1
			return
		}
		if (!watcher.match?.url) {
			output.writeWarn(`Watcher "${options.fromWatcher}" has no match.url configured.`)
			process.exitCode = 2
			return
		}
		startupUrl = normalizeHttpUrl(watcher.match.url)
	} else if (options.url) {
		startupUrl = normalizeHttpUrl(options.url)
	}

	// Read the auth-state file before spawning, so a bad path fails without launching a browser.
	let authStateSnapshot: AuthStateSnapshot | null = null
	if (options.authState) {
		try {
			authStateSnapshot = await loadAuthStateSnapshot(options.authState)
		} catch (error) {
			output.writeWarn(formatError(error))
			process.exitCode = 1
			return
		}
	}

	let result: LaunchChromeResult
	try {
		result = await launchChrome({
			url: startupUrl,
			profile: options.profile,
			devTools: options.devTools,
			headless: options.headless,
			mute: options.mute,
			userAgent: options.userAgent,
			authState: authStateSnapshot,
		})
	} catch (error) {
		output.writeWarn(formatError(error))
		process.exitCode = 1
		return
	}

	startupUrl = result.startupUrl

	registerTerminationHandlers(() => result.closeGracefully())

	result.chrome.on('exit', () => {
		process.exit(0)
	})

	const info: ChromeStartResult = {
		chromePid: result.chrome.pid!,
		cdpHost: result.cdpHost,
		cdpPort: result.cdpPort,
		userDataDir: result.userDataDir,
		startupUrl,
	}
	if (options.userAgent !== undefined) {
		info.userAgentOverride = true
	}

	if (options.json) {
		output.writeJson(info)
	} else {
		output.writeHuman(`Chrome started:`)
		output.writeHuman(`  pid=${info.chromePid}`)
		output.writeHuman(`  cdp=${info.cdpHost}:${info.cdpPort}`)
		output.writeHuman(`  userDataDir=${info.userDataDir}`)
		if (info.startupUrl) {
			output.writeHuman(`  url=${info.startupUrl}`)
		}
		if (info.userAgentOverride) {
			output.writeHuman('  userAgent=overridden')
		}
	}

	await waitForever()
}
