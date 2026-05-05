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

export const getManifestDir = (platform: Platform): string => {
	switch (platform) {
		case 'darwin':
			return path.join(os.homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts')
		case 'linux':
			return path.join(os.homedir(), '.config/google-chrome/NativeMessagingHosts')
		case 'win32':
			return path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'Google/Chrome/User Data/NativeMessagingHosts')
		default:
			throw new Error(`Unsupported platform: ${platform}`)
	}
}

export const getManifestPath = (platform: Platform, hostName: NativeHostName = BRIDGE_HOST_NAME): string => {
	return path.join(getManifestDir(platform), `${hostName}.json`)
}

export const getWrapperPath = (platform: Platform, hostName: NativeHostName = BRIDGE_HOST_NAME): string => {
	const filename = hostName === CONTROL_HOST_NAME ? 'argus-native-control-host.sh' : 'argus-native-host.sh'
	return path.join(getManifestDir(platform), filename)
}

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

export const createWrapperScript = (platform: Platform, executablePath: string, hostName: NativeHostName = BRIDGE_HOST_NAME): string => {
	const wrapperPath = getWrapperPath(platform, hostName)
	const nodePath = findNodePath()
	const args = hostName === CONTROL_HOST_NAME ? `watcher native-host --role control --id ${CONTROL_WATCHER_ID}` : 'watcher native-host --role tab'

	// Create a wrapper script that launches argus in native-host mode
	// Use absolute path to node since Chrome spawns without shell profile
	const script = `#!/bin/bash
exec "${nodePath}" "${executablePath}" ${args}
`

	fs.writeFileSync(wrapperPath, script, { mode: 0o755 })
	return wrapperPath
}

export const installNativeHosts = (platform: Platform, extensionId: string, executablePath: string): InstalledNativeHost[] => {
	fs.mkdirSync(getManifestDir(platform), { recursive: true })
	return HOST_NAMES.map((hostName) => {
		const wrapperPath = createWrapperScript(platform, executablePath, hostName)
		const manifestPath = getManifestPath(platform, hostName)
		const manifest = createManifest(extensionId, wrapperPath, hostName)
		fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
		registerWindowsNativeHost(platform, hostName, manifestPath)
		return { hostName, manifestPath, wrapperPath }
	})
}

export const inspectNativeHosts = (platform: Platform): NativeHostInspection[] => {
	return HOST_NAMES.map((hostName) => inspectNativeHost(platform, hostName))
}

export const removeNativeHosts = (platform: Platform): RemovedNativeHost[] => {
	return HOST_NAMES.map((hostName) => {
		const host = inspectNativeHost(platform, hostName)
		const manifestRemoved = removeFileIfExists(host.manifestPath)
		const wrapperRemoved = removeFileIfExists(host.wrapperPath)
		unregisterWindowsNativeHost(platform, hostName)
		return { ...host, manifestRemoved, wrapperRemoved }
	})
}

export const inspectNativeHost = (platform: Platform, hostName: NativeHostName): NativeHostInspection => {
	const manifestPath = getManifestPath(platform, hostName)
	const wrapperPath = getWrapperPath(platform, hostName)
	const manifestExists = fs.existsSync(manifestPath)
	const wrapperExists = fs.existsSync(wrapperPath)
	const wrapperExecutable = wrapperExists && isWrapperExecutable(wrapperPath)
	const manifest = manifestExists ? readManifest(manifestPath) : null
	const manifestValid = Boolean(manifest && manifest.name === hostName && manifest.type === 'stdio' && Array.isArray(manifest.allowed_origins))
	const extensionId = extractExtensionId(manifest?.allowed_origins?.[0])

	return {
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

const registerWindowsNativeHost = (platform: Platform, hostName: NativeHostName, manifestPath: string): void => {
	if (platform !== 'win32') {
		return
	}
	const regKey = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`
	execSync(`reg add "${regKey}" /ve /t REG_SZ /d "${manifestPath}" /f`, { stdio: 'pipe' })
}

const unregisterWindowsNativeHost = (platform: Platform, hostName: NativeHostName): void => {
	if (platform !== 'win32') {
		return
	}
	const regKey = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`
	try {
		execSync(`reg delete "${regKey}" /f`, { stdio: 'pipe' })
	} catch {
		// Key might not exist.
	}
}
