import { nativeHostDiagnosticsScript, quoteNativeShell } from './nativeHostDiagnostics.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execSync } from 'node:child_process'

export const BRIDGE_HOST_NAME = 'com.vforsh.argus.bridge'
export const CONTROL_HOST_NAME = 'com.vforsh.argus.control'
export const CONTROL_WATCHER_ID = 'extension-control'
export const HOST_NAMES = [BRIDGE_HOST_NAME, CONTROL_HOST_NAME] as const

export type NativeHostName = (typeof HOST_NAMES)[number]

export type Platform = 'darwin' | 'linux' | 'win32'

/** Chromium-family browsers whose native messaging host locations Argus knows. */
export const HOST_BROWSERS = ['chrome', 'chromium'] as const

export type HostBrowser = (typeof HOST_BROWSERS)[number]

const getUserDataDir = (platform: Platform, browser: HostBrowser): string => {
	const chrome = browser === 'chrome'
	switch (platform) {
		case 'darwin':
			return path.join(os.homedir(), 'Library/Application Support', chrome ? 'Google/Chrome' : 'Chromium')
		case 'linux':
			return path.join(os.homedir(), '.config', chrome ? 'google-chrome' : 'chromium')
		case 'win32':
			return path.join(process.env.LOCALAPPDATA ?? os.homedir(), chrome ? 'Google/Chrome/User Data' : 'Chromium/User Data')
		default:
			throw new Error(`Unsupported platform: ${platform}`)
	}
}

/**
 * Browsers to install native hosts for: every one with an existing profile, so Chrome and
 * Chromium side by side both get them. Chrome alone when none exists yet, since its directory
 * is still the right place for a browser that has not been launched.
 */
export const detectHostBrowsers = (platform: Platform): HostBrowser[] => {
	const present = HOST_BROWSERS.filter((browser) => fs.existsSync(getUserDataDir(platform, browser)))
	return present.length > 0 ? present : ['chrome']
}

export const getManifestDir = (platform: Platform, browser: HostBrowser): string => {
	return path.join(getUserDataDir(platform, browser), 'NativeMessagingHosts')
}

export const getManifestPath = (platform: Platform, hostName: NativeHostName, browser: HostBrowser): string => {
	return path.join(getManifestDir(platform, browser), `${hostName}.json`)
}

export const getWrapperPath = (platform: Platform, hostName: NativeHostName, browser: HostBrowser): string => {
	return path.join(getManifestDir(platform, browser), wrapperFilename(hostName))
}

const wrapperFilename = (hostName: NativeHostName): string =>
	hostName === CONTROL_HOST_NAME ? 'argus-native-control-host.sh' : 'argus-native-host.sh'

export const getPlatform = (): Platform => {
	const platform = os.platform()
	if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
		throw new Error(`Unsupported platform: ${platform}`)
	}
	return platform
}

export const findArgusExecutable = (): string => {
	// Check for globally installed argus
	try {
		const npmGlobalPrefix = execSync('npm config get prefix', { encoding: 'utf8' }).trim()
		const globalBinPath = path.join(npmGlobalPrefix, 'bin', 'argus')
		if (fs.existsSync(globalBinPath)) {
			return globalBinPath
		}
	} catch {
		// Ignore
	}

	// Check if argus is in PATH
	try {
		const whichPath = execSync('which argus', { encoding: 'utf8' }).trim()
		if (whichPath) {
			return whichPath
		}
	} catch {
		// Ignore
	}

	throw new Error('Could not find argus executable. Please install argus globally (npm install -g @vforsh/argus) or ensure it is in your PATH.')
}

export const findNodePath = (): string => {
	// Get the current node executable path and resolve any symlinks
	// This is important for fnm/nvm which use symlinks in temporary directories
	return fs.realpathSync(process.execPath)
}

export type NativeHostManifest = {
	name: string
	description: string
	path: string
	type: 'stdio'
	allowed_origins: string[]
}

export type NativeHostInspection = {
	browser: HostBrowser
	hostName: NativeHostName
	manifestPath: string
	wrapperPath: string
	manifestExists: boolean
	manifestValid: boolean
	wrapperExists: boolean
	wrapperExecutable: boolean
	configured: boolean
	installed: boolean
	extensionId: string | null
	argusPath: string | null
}

export type InstalledNativeHost = {
	hostName: NativeHostName
	manifestPath: string
	wrapperPath: string
}

export type InstalledBrowserNativeHost = InstalledNativeHost & { browser: HostBrowser }

export type RemovedNativeHost = NativeHostInspection & {
	manifestRemoved: boolean
	wrapperRemoved: boolean
}

export const createManifest = (extensionId: string, executablePath: string, hostName: NativeHostName = BRIDGE_HOST_NAME): NativeHostManifest => {
	return {
		name: hostName,
		description: hostName === CONTROL_HOST_NAME ? 'Argus Extension Control Native Messaging Host' : 'Argus Watcher Native Messaging Host',
		path: executablePath,
		type: 'stdio',
		allowed_origins: [`chrome-extension://${extensionId}/`],
	}
}

export const createWrapperScript = (platform: Platform, executablePath: string, hostName: NativeHostName, browser: HostBrowser): string => {
	return writeWrapperScript(getWrapperPath(platform, hostName, browser), executablePath, hostName)
}

const writeWrapperScript = (
	wrapperPath: string,
	executablePath: string,
	hostName: NativeHostName,
	env?: Record<string, string>,
	nodePath: string = findNodePath(),
): string => {
	const args = hostName === CONTROL_HOST_NAME ? `watcher native-host --role control --id ${CONTROL_WATCHER_ID}` : 'watcher native-host --role tab'

	// Chrome spawns the host without a shell profile, so the wrapper must carry everything
	// itself: an absolute node path, and any env the host needs baked in as export lines.
	const exports = Object.entries(env ?? {})
		.map(([key, value]) => `export ${key}=${quoteNativeShell(value)}`)
		.join('\n')
	const script = `#!/bin/bash
${exports ? `${exports}\n` : ''}${nativeHostDiagnosticsScript(hostName === CONTROL_HOST_NAME ? 'control' : 'tab', `${quoteNativeShell(nodePath)} ${quoteNativeShell(executablePath)} ${args}`)}
`

	fs.writeFileSync(wrapperPath, script, { mode: 0o755 })
	return wrapperPath
}

/** Install both hosts for every browser {@link detectHostBrowsers} finds. */
export const installNativeHosts = (platform: Platform, extensionId: string, executablePath: string): InstalledBrowserNativeHost[] => {
	return detectHostBrowsers(platform).flatMap((browser) => {
		fs.mkdirSync(getManifestDir(platform, browser), { recursive: true })
		return HOST_NAMES.map((hostName) => {
			const wrapperPath = createWrapperScript(platform, executablePath, hostName, browser)
			const manifestPath = getManifestPath(platform, hostName, browser)
			const manifest = createManifest(extensionId, wrapperPath, hostName)
			fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
			registerWindowsNativeHost(platform, browser, hostName, manifestPath)
			return { browser, hostName, manifestPath, wrapperPath }
		})
	})
}

/**
 * Install both native messaging host manifests into an explicit directory instead of the
 * running Chrome profile's fixed location.
 *
 * Chromium resolves user-level native messaging hosts under the active user data dir on
 * macOS and Linux, so pointing this at `<user-data-dir>/NativeMessagingHosts` gives a
 * temp Chrome profile a fully isolated bridge — the real profile is never touched. Used
 * by the extension e2e harness; not wired to any CLI command.
 *
 * @param manifestDir - Directory to write manifests and wrapper scripts into (created if missing).
 * @param extensionId - Extension id allowed to connect (`allowed_origins`).
 * @param executablePath - Absolute path to the argus CLI entry (e.g. a repo `dist/bin.js`).
 * @param options - `env`: vars baked into the wrapper scripts (Chrome spawns hosts with no
 *   shell profile, so isolation vars like `ARGUS_HOME`/`ARGUS_REGISTRY_PATH` must travel
 *   here); `nodePath`: runtime for the host process — defaults to the current executable's
 *   realpath, which under `bun test` is bun, so pass an explicit node to match production.
 * @returns One record per host with the written manifest and wrapper paths.
 */
export const installNativeHostsTo = (
	manifestDir: string,
	extensionId: string,
	executablePath: string,
	options?: { env?: Record<string, string>; nodePath?: string },
): InstalledNativeHost[] => {
	fs.mkdirSync(manifestDir, { recursive: true })
	return HOST_NAMES.map((hostName) => {
		const wrapperPath = writeWrapperScript(
			path.join(manifestDir, wrapperFilename(hostName)),
			executablePath,
			hostName,
			options?.env,
			options?.nodePath ?? findNodePath(),
		)
		const manifestPath = path.join(manifestDir, `${hostName}.json`)
		fs.writeFileSync(manifestPath, JSON.stringify(createManifest(extensionId, wrapperPath, hostName), null, 2))
		return { hostName, manifestPath, wrapperPath }
	})
}

/** Inspect both hosts for every browser {@link detectHostBrowsers} finds. */
export const inspectNativeHosts = (platform: Platform): NativeHostInspection[] => {
	return detectHostBrowsers(platform).flatMap((browser) => HOST_NAMES.map((hostName) => inspectNativeHost(platform, hostName, browser)))
}

/** Remove both hosts for every known browser, including ones whose profile has since been deleted. */
export const removeNativeHosts = (platform: Platform): RemovedNativeHost[] => {
	return HOST_BROWSERS.flatMap((browser) =>
		HOST_NAMES.map((hostName) => {
			const host = inspectNativeHost(platform, hostName, browser)
			const manifestRemoved = removeFileIfExists(host.manifestPath)
			const wrapperRemoved = removeFileIfExists(host.wrapperPath)
			unregisterWindowsNativeHost(platform, browser, hostName)
			return { ...host, manifestRemoved, wrapperRemoved }
		}),
	)
}

export const inspectNativeHost = (platform: Platform, hostName: NativeHostName, browser: HostBrowser): NativeHostInspection => {
	const manifestPath = getManifestPath(platform, hostName, browser)
	const wrapperPath = getWrapperPath(platform, hostName, browser)
	const manifestExists = fs.existsSync(manifestPath)
	const wrapperExists = fs.existsSync(wrapperPath)
	const wrapperExecutable = wrapperExists && isWrapperExecutable(wrapperPath)
	const manifest = manifestExists ? readManifest(manifestPath) : null
	const manifestValid = Boolean(manifest && manifest.name === hostName && manifest.type === 'stdio' && Array.isArray(manifest.allowed_origins))
	const extensionId = extractExtensionId(manifest?.allowed_origins?.[0])

	return {
		browser,
		hostName,
		manifestPath,
		wrapperPath,
		manifestExists,
		manifestValid,
		wrapperExists,
		wrapperExecutable,
		configured: manifestExists && manifestValid && wrapperExists && wrapperExecutable,
		installed: manifestExists && wrapperExists,
		extensionId,
		argusPath: manifest?.path ?? null,
	}
}

export const readManifest = (manifestPath: string): NativeHostManifest | null => {
	try {
		const content = fs.readFileSync(manifestPath, 'utf8')
		return JSON.parse(content) as NativeHostManifest
	} catch {
		return null
	}
}

export const isWrapperExecutable = (wrapperPath: string): boolean => {
	try {
		fs.accessSync(wrapperPath, fs.constants.X_OK)
		return true
	} catch {
		return false
	}
}

export const shortenPath = (filePath: string): string => {
	const home = os.homedir()
	if (filePath.startsWith(home)) {
		return filePath.replace(home, '~')
	}
	return filePath
}

const extractExtensionId = (origin: string | undefined): string | null => {
	if (!origin) {
		return null
	}
	const match = origin.match(/^chrome-extension:\/\/([^/]+)\/$/)
	return match?.[1] ?? null
}

const removeFileIfExists = (filePath: string): boolean => {
	if (!fs.existsSync(filePath)) {
		return false
	}
	fs.unlinkSync(filePath)
	return true
}

const windowsRegistryKey = (browser: HostBrowser, hostName: NativeHostName): string =>
	`HKCU\\Software\\${browser === 'chrome' ? 'Google\\Chrome' : 'Chromium'}\\NativeMessagingHosts\\${hostName}`

const registerWindowsNativeHost = (platform: Platform, browser: HostBrowser, hostName: NativeHostName, manifestPath: string): void => {
	if (platform !== 'win32') {
		return
	}
	execSync(`reg add "${windowsRegistryKey(browser, hostName)}" /ve /t REG_SZ /d "${manifestPath}" /f`, { stdio: 'pipe' })
}

const unregisterWindowsNativeHost = (platform: Platform, browser: HostBrowser, hostName: NativeHostName): void => {
	if (platform !== 'win32') {
		return
	}
	try {
		execSync(`reg delete "${windowsRegistryKey(browser, hostName)}" /f`, { stdio: 'pipe' })
	} catch {
		// Key might not exist.
	}
}
