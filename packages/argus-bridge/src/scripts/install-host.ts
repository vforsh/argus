/**
 * Install/uninstall Native Messaging host manifest.
 *
 * The manifest tells Chrome where to find the argus-bridge executable
 * and which extensions are allowed to use it.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const HOST_NAME = 'com.vforsh.argus.bridge'

/**
 * Get the Native Messaging hosts directory for the current platform.
 */
const getHostsDirectory = () => {
	const platform = process.platform
	const home = os.homedir()

	switch (platform) {
		case 'darwin':
			return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts')
		case 'linux':
			return path.join(home, '.config', 'google-chrome', 'NativeMessagingHosts')
		case 'win32':
			// On Windows, we also need to create a registry key
			// For now, return the manifest directory
			return path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'NativeMessagingHosts')
		default:
			throw new Error(`Unsupported platform: ${platform}`)
	}
}

/**
 * Get the path to the argus-bridge executable.
 */
const getExecutablePath = () => {
	// Try to find the bin path from package resolution
	const __dirname = path.dirname(fileURLToPath(import.meta.url))

	// Go up from scripts/ to src/ to package root, then to dist/bin.js
	const packageRoot = path.resolve(__dirname, '..', '..')
	const binPath = path.join(packageRoot, 'dist', 'bin.js')

	// Create a wrapper script that runs node with the bin.js
	const wrapperPath = path.join(packageRoot, 'argus-bridge-host')

	return { binPath, wrapperPath, packageRoot }
}

/**
 * Create the Native Messaging host manifest.
 */
const createManifest = (executablePath: string, extensionId?: string) => {
	const allowedOrigins = extensionId
		? [`chrome-extension://${extensionId}/`]
		: [
				// Allow any extension during development
				// In production, this should be restricted to the actual extension ID
				'chrome-extension://*/*',
			]

	return {
		name: HOST_NAME,
		description: 'Argus CDP Bridge Native Messaging Host',
		path: executablePath,
		type: 'stdio',
		allowed_origins: allowedOrigins,
	}
}

/**
 * Install the Native Messaging host.
 */
export const installNativeHost = async (extensionId?: string): Promise<void> => {
	const hostsDir = getHostsDirectory()
	const { binPath, wrapperPath, packageRoot } = getExecutablePath()

	// Ensure the hosts directory exists
	fs.mkdirSync(hostsDir, { recursive: true })

	// Create wrapper script based on platform
	const platform = process.platform
	let wrapper

	if (platform === 'win32') {
		// Windows batch file
		wrapper = `@echo off
node "${binPath}" start %*`
		const wrapperBat = wrapperPath + '.bat'
		fs.writeFileSync(wrapperBat, wrapper, 'utf8')

		// Create manifest pointing to the batch file
		const manifest = createManifest(wrapperBat, extensionId)
		const manifestPath = path.join(hostsDir, `${HOST_NAME}.json`)
		fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

		console.log(`Manifest installed: ${manifestPath}`)
		console.log(`Wrapper script: ${wrapperBat}`)

		// TODO: Add Windows registry key for Chrome to find the manifest
		console.log('\nNote: On Windows, you may need to add a registry key manually:')
		console.log(`  HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`)
		console.log(`  Default value: ${manifestPath}`)
	} else {
		// Unix shell script
		wrapper = `#!/bin/sh
exec node "${binPath}" start "$@"`

		fs.writeFileSync(wrapperPath, wrapper, { mode: 0o755 })

		// Create manifest pointing to the shell script
		const manifest = createManifest(wrapperPath, extensionId)
		const manifestPath = path.join(hostsDir, `${HOST_NAME}.json`)
		fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

		console.log(`Manifest installed: ${manifestPath}`)
		console.log(`Wrapper script: ${wrapperPath}`)
	}

	console.log(`\nHost name: ${HOST_NAME}`)
	if (extensionId) {
		console.log(`Allowed extension: ${extensionId}`)
	} else {
		console.log('Allowed extensions: all (development mode)')
	}
}

/**
 * Uninstall the Native Messaging host.
 */
export const uninstallNativeHost = async () => {
	const hostsDir = getHostsDirectory()
	const { wrapperPath } = getExecutablePath()
	const manifestPath = path.join(hostsDir, `${HOST_NAME}.json`)

	// Remove manifest
	if (fs.existsSync(manifestPath)) {
		fs.unlinkSync(manifestPath)
		console.log(`Removed manifest: ${manifestPath}`)
	}

	// Remove wrapper script
	if (fs.existsSync(wrapperPath)) {
		fs.unlinkSync(wrapperPath)
		console.log(`Removed wrapper: ${wrapperPath}`)
	}

	const wrapperBat = wrapperPath + '.bat'
	if (fs.existsSync(wrapperBat)) {
		fs.unlinkSync(wrapperBat)
		console.log(`Removed wrapper: ${wrapperBat}`)
	}

	console.log('\nNative Messaging host uninstalled')

	if (process.platform === 'win32') {
		console.log('\nNote: You may need to remove the registry key manually:')
		console.log(`  HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`)
	}
}

// If run directly
const __filename = fileURLToPath(import.meta.url)
if (process.argv[1] === __filename) {
	const command = process.argv[2]
	if (command === 'install') {
		installNativeHost(process.argv[3])
	} else if (command === 'uninstall') {
		uninstallNativeHost()
	} else {
		console.log('Usage: install-host.js [install|uninstall] [extension-id]')
	}
}
