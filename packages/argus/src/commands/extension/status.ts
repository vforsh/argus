import fs from 'node:fs'
import { createOutput } from '../../output/io.js'
import { HOST_NAME, getPlatform, getManifestPath, getWrapperPath, readManifest, isWrapperExecutable } from './nativeHost.js'

export type ExtensionStatusOptions = {
	json?: boolean
}

export const runExtensionStatus = async (options: ExtensionStatusOptions): Promise<void> => {
	const output = createOutput(options)

	let platform
	try {
		platform = getPlatform()
	} catch (error) {
		if (options.json) {
			output.writeJson({ configured: false, error: (error as Error).message })
		} else {
			console.error((error as Error).message)
		}
		process.exitCode = 1
		return
	}

	const manifestPath = getManifestPath(platform)
	const wrapperPath = getWrapperPath(platform)

	const manifestExists = fs.existsSync(manifestPath)
	const wrapperExists = fs.existsSync(wrapperPath)
	const wrapperExecutable = wrapperExists && isWrapperExecutable(wrapperPath)

	let manifest = null
	let manifestValid = false
	let extensionId: string | null = null

	if (manifestExists) {
		manifest = readManifest(manifestPath)
		if (manifest && manifest.name === HOST_NAME && manifest.type === 'stdio' && Array.isArray(manifest.allowed_origins)) {
			manifestValid = true
			const origin = manifest.allowed_origins[0]
			if (origin) {
				const match = origin.match(/^chrome-extension:\/\/([^/]+)\/$/)
				if (match) {
					extensionId = match[1]
				}
			}
		}
	}

	const configured = manifestExists && manifestValid && wrapperExists && wrapperExecutable

	if (options.json) {
		output.writeJson({
			configured,
			hostName: HOST_NAME,
			manifestPath,
			wrapperPath,
			manifestExists,
			manifestValid,
			wrapperExists,
			wrapperExecutable,
			extensionId,
			argusPath: manifest?.path ?? null,
		})
		if (!configured) {
			process.exitCode = 1
		}
		return
	}

	output.writeHuman('')
	if (configured) {
		output.writeHuman('Native messaging host is configured')
		output.writeHuman('')
		output.writeHuman(`  Manifest:     exists`)
		output.writeHuman(`  Wrapper:      exists, executable`)
		output.writeHuman(`  Extension ID: ${extensionId}`)
	} else {
		output.writeHuman('Native messaging host not configured')
		output.writeHuman('')
		output.writeHuman(`  Manifest:     ${manifestExists ? (manifestValid ? 'exists' : 'exists, invalid') : 'not found'}`)
		output.writeHuman(`  Wrapper:      ${wrapperExists ? (wrapperExecutable ? 'exists, executable' : 'exists, not executable') : 'not found'}`)
		if (extensionId) {
			output.writeHuman(`  Extension ID: ${extensionId}`)
		}
		output.writeHuman('')
		output.writeHuman("Run 'argus extension setup <extensionId>' to install.")
		process.exitCode = 1
	}
	output.writeHuman('')
}
