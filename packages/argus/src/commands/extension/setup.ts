import { formatError } from '../../cli/parse.js'
import { emitFailure, getPlatformOrFail } from './failures.js'
import { createOutput } from '../../output/io.js'
import { findArgusExecutable, installNativeHosts, shortenPath } from './nativeHost.js'
import { ARGUS_EXTENSION_ID } from './extensionId.js'

export type ExtensionSetupOptions = {
	/** Override the pinned extension ID. Defaults to {@link ARGUS_EXTENSION_ID}. */
	extensionId?: string
	json?: boolean
}

export const runExtensionSetup = async (options: ExtensionSetupOptions): Promise<void> => {
	const output = createOutput(options)
	const extensionId = options.extensionId ?? ARGUS_EXTENSION_ID

	const platform = getPlatformOrFail(output)
	if (!platform) return

	let executablePath: string
	try {
		executablePath = findArgusExecutable()
	} catch (error) {
		emitFailure(output, { error, code: 'argus_executable_not_found' })
		return
	}

	let installedHosts
	try {
		installedHosts = installNativeHosts(platform, extensionId, executablePath)
	} catch (error) {
		emitFailure(output, { error: `Failed to install native hosts: ${formatError(error)}`, code: 'native_host_install_failed' })
		return
	}

	if (options.json) {
		output.writeJson({
			ok: true,
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
		output.writeHuman('  1. Load the unpacked extension from `argus extension path` (if not already loaded)')
		output.writeHuman('  2. Run `argus ext tabs` or open the extension popup and attach a tab')
		output.writeHuman('')
		output.writeHuman('Tip: `argus extension install` does this end-to-end and waits for the extension to connect.')
		output.writeHuman('')
	}
}
