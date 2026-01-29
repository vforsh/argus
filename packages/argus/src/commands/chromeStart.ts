import { spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fetchJson } from '../httpClient.js'
import { loadRegistry, pruneRegistry } from '../registry.js'
import { createOutput } from '../output/io.js'
import { resolveChromeBin } from '../utils/chromeBin.js'
import { getCdpPort } from '../utils/ports.js'
import type { ChromeVersionResponse } from './chrome.js'

export type ChromeStartOptions = {
	url?: string
	fromWatcher?: string
	json?: boolean
	profile?: 'temp' | 'default-full' | 'default-medium' | 'default-lite'
	devTools?: boolean
	headless?: boolean
}

type ChromeStartResult = {
	chromePid: number
	cdpHost: string
	cdpPort: number
	userDataDir: string | null
	startupUrl: string | null
}

type ChromeStartReadyResult = {
	ready: true
	version: string
}

type ChromeStartNotReadyResult = {
	ready: false
	error: string
}

type ChromeStartReadyCheck = ChromeStartReadyResult | ChromeStartNotReadyResult

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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

const waitForCdpReady = async (host: string, port: number, chrome: ChildProcess): Promise<ChromeStartReadyCheck> => {
	const deadline = Date.now() + 5_000
	const url = `http://${host}:${port}/json/version`
	let lastError: string | null = null

	while (Date.now() < deadline) {
		if (chrome.exitCode !== null) {
			return { ready: false, error: 'Chrome exited before CDP became reachable.' }
		}

		try {
			const response = await fetchJson<ChromeVersionResponse>(url, { timeoutMs: 500 })
			if (response.Browser) {
				return { ready: true, version: response.Browser }
			}
			lastError = 'Chrome responded without Browser version.'
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error)
		}

		await delay(150)
	}

	return { ready: false, error: lastError ?? 'Timed out waiting for CDP.' }
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

export const runChromeStart = async (options: ChromeStartOptions): Promise<void> => {
	const output = createOutput(options)
	if (options.url && options.fromWatcher) {
		output.writeWarn('Cannot combine --url with --from-watcher. Use one or the other.')
		process.exitCode = 2
		return
	}
	const profile = normalizeProfile(options.profile)
	if (!profile) {
		output.writeWarn('Invalid --profile value. Use temp, default-full, default-medium, or default-lite.')
		process.exitCode = 2
		return
	}

	let startupUrl: string | null = null

	if (options.fromWatcher) {
		const registry = await pruneRegistry(await loadRegistry())
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
		startupUrl = watcher.match.url
		if (!startupUrl.startsWith('http://') && !startupUrl.startsWith('https://')) {
			startupUrl = `http://${startupUrl}`
		}
	} else if (options.url) {
		startupUrl = options.url
	}

	const chromeBin = resolveChromeBin()
	if (!chromeBin) {
		output.writeWarn('Chrome executable not found. Set ARGUS_CHROME_BIN environment variable.')
		process.exitCode = 1
		return
	}

	let userDataDir: string | null = null
	if (profile !== 'temp') {
		const sourceDir = resolveChromeUserDataDir()
		if (!sourceDir) {
			output.writeWarn('Chrome user data dir not found. Set ARGUS_CHROME_USER_DATA_DIR.')
			process.exitCode = 1
			return
		}
		try {
			if (profile === 'default-lite') {
				userDataDir = copyDefaultProfileLite(sourceDir)
			} else if (profile === 'default-medium') {
				userDataDir = copyDefaultProfileMedium(sourceDir)
			} else {
				userDataDir = copyDefaultProfile(sourceDir)
			}
		} catch (error) {
			const label =
				profile === 'default-lite'
					? 'default Chrome profile (lite)'
					: profile === 'default-medium'
						? 'default Chrome profile (medium)'
						: 'default Chrome profile'
			output.writeWarn(`Failed to copy ${label}: ${error instanceof Error ? error.message : error}`)
			process.exitCode = 1
			return
		}
	}

	const cdpPort = await getCdpPort()
	const cdpHost = '127.0.0.1'
	if (!userDataDir) {
		userDataDir = mkdtempSync(path.join(tmpdir(), 'argus-chrome-'))
	}

	const args = [`--remote-debugging-port=${cdpPort}`]
	if (userDataDir) {
		args.push(`--user-data-dir=${userDataDir}`)
		args.push('--no-first-run')
		args.push('--no-default-browser-check')
	}
	if (options.devTools) {
		args.push('--auto-open-devtools-for-tabs')
	}
	if (options.headless) {
		args.push('--headless=new')
	}
	if (startupUrl) {
		args.push(startupUrl)
	}

	let chrome: ChildProcess
	try {
		chrome = spawn(chromeBin, args, {
			stdio: 'ignore',
			detached: false,
		})
	} catch (error) {
		output.writeWarn(`Failed to spawn Chrome: ${error instanceof Error ? error.message : error}`)
		if (userDataDir) {
			rmSync(userDataDir, { recursive: true, force: true })
		}
		process.exitCode = 1
		return
	}

	if (!chrome.pid) {
		output.writeWarn('Failed to start Chrome: no PID returned.')
		if (userDataDir) {
			rmSync(userDataDir, { recursive: true, force: true })
		}
		process.exitCode = 1
		return
	}

	const result: ChromeStartResult = {
		chromePid: chrome.pid,
		cdpHost,
		cdpPort,
		userDataDir,
		startupUrl,
	}

	const ready = await waitForCdpReady(cdpHost, cdpPort, chrome)
	if (!ready.ready) {
		output.writeWarn(`Chrome started but CDP is unavailable at ${cdpHost}:${cdpPort}.`)
		output.writeWarn(`Reason: ${ready.error}`)
		if (userDataDir) {
			try {
				rmSync(userDataDir, { recursive: true, force: true })
			} catch {}
		}
		try {
			chrome.kill()
		} catch {}
		process.exitCode = 1
		return
	}

	const cleanup = () => {
		try {
			chrome.kill()
		} catch {}
		if (userDataDir) {
			try {
				rmSync(userDataDir, { recursive: true, force: true })
			} catch {}
		}
	}

	process.on('SIGINT', () => {
		cleanup()
		process.exit(0)
	})
	process.on('SIGTERM', () => {
		cleanup()
		process.exit(0)
	})

	chrome.on('exit', () => {
		if (userDataDir) {
			try {
				rmSync(userDataDir, { recursive: true, force: true })
			} catch {}
		}
		process.exit(0)
	})

	if (options.json) {
		output.writeJson(result)
	} else {
		output.writeHuman(`Chrome started:`)
		output.writeHuman(`  pid=${result.chromePid}`)
		output.writeHuman(`  cdp=${result.cdpHost}:${result.cdpPort}`)
		output.writeHuman(`  userDataDir=${result.userDataDir}`)
		if (result.startupUrl) {
			output.writeHuman(`  url=${result.startupUrl}`)
		}
	}

	await new Promise(() => {})
}
