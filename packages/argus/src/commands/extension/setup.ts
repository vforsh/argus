import { createOutput } from '../../output/io.js'
import { getPlatform, findArgusExecutable, installNativeHosts, shortenPath } from './nativeHost.js'

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

	let installedHosts
	try {
		installedHosts = installNativeHosts(platform, extensionId, executablePath)
	} catch (error) {
		if (options.json) {
			output.writeJson({ success: false, error: `Failed to install native hosts: ${(error as Error).message}` })
		} else {
			console.error('Failed to install native hosts:', error)
		}
		process.exitCode = 1
		return
	}

	if (options.json) {
		output.writeJson({
			success: true,
			extensionId,
			hosts: installedHosts,
			argusPath: executablePath,
		})
	} else {
		output.writeHuman('')
		output.writeHuman('Native messaging hosts installed')
		output.writeHuman('')
		output.writeHuman(`  Extension ID: ${extensionId}`)
		for (const host of installedHosts) {
			output.writeHuman(`  Host name:    ${host.hostName}`)
			output.writeHuman(`  Manifest:     ${shortenPath(host.manifestPath)}`)
			output.writeHuman(`  Wrapper:      ${shortenPath(host.wrapperPath)}`)
		}
		output.writeHuman('')
		output.writeHuman('Next steps:')
		output.writeHuman('  1. Reload the extension in chrome://extensions')
		output.writeHuman('  2. Run `argus ext tabs` or open the extension popup and attach a tab')
		output.writeHuman('')
	}
}
