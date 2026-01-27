import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execSync } from 'node:child_process'

export const HOST_NAME = 'com.vforsh.argus.bridge'

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

export const getManifestPath = (platform: Platform): string => {
	return path.join(getManifestDir(platform), `${HOST_NAME}.json`)
}

export const getWrapperPath = (platform: Platform): string => {
	return path.join(getManifestDir(platform), 'argus-native-host.sh')
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

export const createManifest = (extensionId: string, executablePath: string): NativeHostManifest => {
	return {
		name: HOST_NAME,
		description: 'Argus Watcher Native Messaging Host',
		path: executablePath,
		type: 'stdio',
		allowed_origins: [`chrome-extension://${extensionId}/`],
	}
}

export const createWrapperScript = (platform: Platform, executablePath: string): string => {
	const wrapperDir = getManifestDir(platform)
	const wrapperPath = path.join(wrapperDir, 'argus-native-host.sh')
	const nodePath = findNodePath()

	// Create a wrapper script that launches argus in native-host mode
	// Use absolute path to node since Chrome spawns without shell profile
	const script = `#!/bin/bash
exec "${nodePath}" "${executablePath}" watcher native-host
`

	fs.writeFileSync(wrapperPath, script, { mode: 0o755 })
	return wrapperPath
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
