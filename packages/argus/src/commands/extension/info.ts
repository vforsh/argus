import fs from 'node:fs'
import { createOutput } from '../../output/io.js'
import { HOST_NAME, getPlatform, getManifestPath, getWrapperPath, readManifest, shortenPath } from './nativeHost.js'

export type ExtensionInfoOptions = {
	json?: boolean
}

export const runExtensionInfo = async (options: ExtensionInfoOptions): Promise<void> => {
	const output = createOutput(options)

	let platform
	try {
		platform = getPlatform()
	} catch (error) {
		if (options.json) {
			output.writeJson({ error: (error as Error).message })
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

	let extensionId: string | null = null
	let argusPath: string | null = null

	if (manifestExists) {
		const manifest = readManifest(manifestPath)
		if (manifest) {
			argusPath = manifest.path
			const origin = manifest.allowed_origins?.[0]
			if (origin) {
				const match = origin.match(/^chrome-extension:\/\/([^/]+)\/$/)
				if (match) {
					extensionId = match[1]
				}
			}
		}
	}

	const installed = manifestExists && wrapperExists

	if (options.json) {
		output.writeJson({
			hostName: HOST_NAME,
			platform,
			manifestPath,
			wrapperPath,
			installed,
			extensionId,
			argusPath,
		})
		return
	}

	output.writeHuman('')
	output.writeHuman('Native Messaging Host Info')
	output.writeHuman('')
	output.writeHuman(`  Host name:     ${HOST_NAME}`)
	output.writeHuman(`  Platform:      ${platform}`)
	output.writeHuman(`  Manifest path: ${shortenPath(manifestPath)}`)
	output.writeHuman(`  Wrapper path:  ${shortenPath(wrapperPath)}`)
	output.writeHuman('')
	output.writeHuman('Current configuration:')
	output.writeHuman(`  Installed:     ${installed ? 'yes' : 'no'}`)
	if (installed) {
		output.writeHuman(`  Extension ID:  ${extensionId ?? '(unknown)'}`)
		output.writeHuman(`  Argus path:    ${argusPath ?? '(unknown)'}`)
	}
	output.writeHuman('')
}
