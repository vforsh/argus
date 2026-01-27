import fs from 'node:fs'
import { execSync } from 'node:child_process'
import { createOutput } from '../../output/io.js'
import {
	HOST_NAME,
	getPlatform,
	getManifestDir,
	getManifestPath,
	getWrapperPath,
	findArgusExecutable,
	createManifest,
	createWrapperScript,
	shortenPath,
} from './nativeHost.js'

export type ExtensionSetupOptions = {
	extensionId: string
	json?: boolean
}

export const runExtensionSetup = async (options: ExtensionSetupOptions): Promise<void> => {
	const output = createOutput(options)
	const { extensionId } = options

	let platform
	try {
		platform = getPlatform()
	} catch (error) {
		if (options.json) {
			output.writeJson({ success: false, error: (error as Error).message })
		} else {
			console.error((error as Error).message)
		}
		process.exitCode = 1
		return
	}

	const manifestDir = getManifestDir(platform)
	const manifestPath = getManifestPath(platform)
	const wrapperPath = getWrapperPath(platform)

	// Ensure directory exists
	fs.mkdirSync(manifestDir, { recursive: true })

	// Find argus executable
	let executablePath: string
	try {
		executablePath = findArgusExecutable()
	} catch (error) {
		if (options.json) {
			output.writeJson({ success: false, error: (error as Error).message })
		} else {
			console.error((error as Error).message)
		}
		process.exitCode = 1
		return
	}

	// Create wrapper script
	createWrapperScript(platform, executablePath)

	// Create manifest
	const manifest = createManifest(extensionId, wrapperPath)
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

	// Windows: Add registry key
	if (platform === 'win32') {
		const regKey = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`
		try {
			execSync(`reg add "${regKey}" /ve /t REG_SZ /d "${manifestPath}" /f`, { stdio: 'pipe' })
		} catch (error) {
			if (options.json) {
				output.writeJson({ success: false, error: `Failed to add registry key: ${(error as Error).message}` })
			} else {
				console.error('Failed to add registry key:', error)
			}
			process.exitCode = 1
			return
		}
	}

	if (options.json) {
		output.writeJson({
			success: true,
			hostName: HOST_NAME,
			extensionId,
			manifestPath,
			wrapperPath,
			argusPath: executablePath,
		})
	} else {
		output.writeHuman('')
		output.writeHuman('Native messaging host installed')
		output.writeHuman('')
		output.writeHuman(`  Host name:    ${HOST_NAME}`)
		output.writeHuman(`  Extension ID: ${extensionId}`)
		output.writeHuman(`  Manifest:     ${shortenPath(manifestPath)}`)
		output.writeHuman(`  Wrapper:      ${shortenPath(wrapperPath)}`)
		output.writeHuman('')
		output.writeHuman('Next steps:')
		output.writeHuman('  1. Reload the extension in chrome://extensions')
		output.writeHuman('  2. Start watcher: argus watcher start --id app --source extension')
		output.writeHuman('')
	}
}
