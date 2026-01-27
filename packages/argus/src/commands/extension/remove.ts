import fs from 'node:fs'
import { execSync } from 'node:child_process'
import { createOutput } from '../../output/io.js'
import { HOST_NAME, getPlatform, getManifestPath, getWrapperPath, shortenPath } from './nativeHost.js'

export type ExtensionRemoveOptions = {
	json?: boolean
}

export const runExtensionRemove = async (options: ExtensionRemoveOptions): Promise<void> => {
	const output = createOutput(options)

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

	const manifestPath = getManifestPath(platform)
	const wrapperPath = getWrapperPath(platform)

	let manifestRemoved = false
	let wrapperRemoved = false

	// Remove manifest
	if (fs.existsSync(manifestPath)) {
		fs.unlinkSync(manifestPath)
		manifestRemoved = true
	}

	// Remove wrapper script
	if (fs.existsSync(wrapperPath)) {
		fs.unlinkSync(wrapperPath)
		wrapperRemoved = true
	}

	// Windows: Remove registry key
	if (platform === 'win32') {
		const regKey = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`
		try {
			execSync(`reg delete "${regKey}" /f`, { stdio: 'pipe' })
		} catch {
			// Key might not exist
		}
	}

	if (options.json) {
		output.writeJson({
			success: true,
			manifestRemoved,
			wrapperRemoved,
			manifestPath,
			wrapperPath,
		})
	} else {
		output.writeHuman('')
		if (manifestRemoved || wrapperRemoved) {
			output.writeHuman('Native messaging host removed')
			output.writeHuman('')
			if (manifestRemoved) {
				output.writeHuman(`  Removed manifest: ${shortenPath(manifestPath)}`)
			}
			if (wrapperRemoved) {
				output.writeHuman(`  Removed wrapper:  ${shortenPath(wrapperPath)}`)
			}
		} else {
			output.writeHuman('Native messaging host was not installed')
			output.writeHuman('')
			output.writeHuman(`  Manifest not found: ${shortenPath(manifestPath)}`)
			output.writeHuman(`  Wrapper not found:  ${shortenPath(wrapperPath)}`)
		}
		output.writeHuman('')
	}
}
