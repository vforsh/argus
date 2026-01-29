#!/usr/bin/env bun
/**
 * Install/uninstall Native Messaging host manifest for the Argus extension.
 *
 * Usage:
 *   node dist/scripts/install-host.js install <EXTENSION_ID>
 *   node dist/scripts/install-host.js uninstall
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execSync } from 'node:child_process'
const __dirname = import.meta.dirname!

const HOST_NAME = 'com.vforsh.argus.bridge'

type Platform = 'darwin' | 'linux' | 'win32'

const getManifestDir = (platform: Platform): string => {
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

const getManifestPath = (platform: Platform): string => {
	return path.join(getManifestDir(platform), `${HOST_NAME}.json`)
}

const findArgusExecutable = (): string => {
	// Try to find the argus CLI executable
	// First, check if we're in a development environment
	const devPath = path.resolve(__dirname, '../../../argus/dist/bin.js')
	if (fs.existsSync(devPath)) {
		return devPath
	}

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

	throw new Error(
		'Could not find argus executable. Please install argus globally (npm install -g @vforsh/argus) or run from the development directory.',
	)
}

const createManifest = (extensionId: string, executablePath: string): object => {
	return {
		name: HOST_NAME,
		description: 'Argus Watcher Native Messaging Host',
		path: executablePath,
		type: 'stdio',
		allowed_origins: [`chrome-extension://${extensionId}/`],
	}
}

const findNodePath = (): string => {
	// Get the current node executable path and resolve any symlinks
	// This is important for fnm/nvm which use symlinks in temporary directories
	return fs.realpathSync(process.execPath)
}

const createWrapperScript = (platform: Platform, executablePath: string): string => {
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

const install = (extensionId: string): void => {
	const platform = os.platform() as Platform
	if (!['darwin', 'linux', 'win32'].includes(platform)) {
		console.error(`Unsupported platform: ${platform}`)
		process.exit(1)
	}

	const manifestDir = getManifestDir(platform)
	const manifestPath = getManifestPath(platform)

	// Ensure directory exists
	fs.mkdirSync(manifestDir, { recursive: true })

	// Find argus executable
	let executablePath: string
	try {
		executablePath = findArgusExecutable()
	} catch (err) {
		console.error((err as Error).message)
		process.exit(1)
	}

	// Create wrapper script (Native Messaging requires a native executable, not node)
	const wrapperPath = createWrapperScript(platform, executablePath)
	console.log(`Created wrapper script: ${wrapperPath}`)

	// Create manifest
	const manifest = createManifest(extensionId, wrapperPath)
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
	console.log(`Created manifest: ${manifestPath}`)

	// Windows: Add registry key
	if (platform === 'win32') {
		const regKey = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`
		try {
			execSync(`reg add "${regKey}" /ve /t REG_SZ /d "${manifestPath}" /f`, { stdio: 'inherit' })
			console.log(`Added registry key: ${regKey}`)
		} catch (err) {
			console.error('Failed to add registry key:', err)
			process.exit(1)
		}
	}

	console.log('\nNative Messaging host installed successfully!')
	console.log(`Host name: ${HOST_NAME}`)
	console.log(`Extension ID: ${extensionId}`)
}

const uninstall = (): void => {
	const platform = os.platform() as Platform
	if (!['darwin', 'linux', 'win32'].includes(platform)) {
		console.error(`Unsupported platform: ${platform}`)
		process.exit(1)
	}

	const manifestPath = getManifestPath(platform)
	const wrapperPath = path.join(getManifestDir(platform), 'argus-native-host.sh')

	// Remove manifest
	if (fs.existsSync(manifestPath)) {
		fs.unlinkSync(manifestPath)
		console.log(`Removed manifest: ${manifestPath}`)
	} else {
		console.log(`Manifest not found: ${manifestPath}`)
	}

	// Remove wrapper script
	if (fs.existsSync(wrapperPath)) {
		fs.unlinkSync(wrapperPath)
		console.log(`Removed wrapper script: ${wrapperPath}`)
	}

	// Windows: Remove registry key
	if (platform === 'win32') {
		const regKey = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`
		try {
			execSync(`reg delete "${regKey}" /f`, { stdio: 'inherit' })
			console.log(`Removed registry key: ${regKey}`)
		} catch {
			// Key might not exist
		}
	}

	console.log('\nNative Messaging host uninstalled.')
}

const main = (): void => {
	const args = process.argv.slice(2)
	const command = args[0]

	if (command === 'install') {
		const extensionId = args[1]
		if (!extensionId) {
			console.error('Usage: install-host install <EXTENSION_ID>')
			console.error('\nTo get your extension ID:')
			console.error('1. Open chrome://extensions')
			console.error('2. Enable Developer mode')
			console.error('3. Load the argus-extension package as unpacked extension')
			console.error('4. Copy the ID shown on the extension card')
			process.exit(1)
		}
		install(extensionId)
	} else if (command === 'uninstall') {
		uninstall()
	} else {
		console.error('Usage:')
		console.error('  install-host install <EXTENSION_ID>')
		console.error('  install-host uninstall')
		process.exit(1)
	}
}

main()
