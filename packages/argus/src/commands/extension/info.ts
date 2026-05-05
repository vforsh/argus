import { createOutput } from '../../output/io.js'
import { getPlatform, inspectNativeHosts, shortenPath } from './nativeHost.js'

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

	const hosts = inspectNativeHosts(platform)
	const installed = hosts.every((host) => host.installed)

	if (options.json) {
		output.writeJson({
			platform,
			installed,
			hosts,
		})
		return
	}

	output.writeHuman('')
	output.writeHuman('Native Messaging Host Info')
	output.writeHuman('')
	output.writeHuman(`  Platform:      ${platform}`)
	for (const host of hosts) {
		output.writeHuman(`  Host name:     ${host.hostName}`)
		output.writeHuman(`  Manifest path: ${shortenPath(host.manifestPath)}`)
		output.writeHuman(`  Wrapper path:  ${shortenPath(host.wrapperPath)}`)
	}
	output.writeHuman('')
	output.writeHuman('Current configuration:')
	output.writeHuman(`  Installed:     ${installed ? 'yes' : 'no'}`)
	for (const host of hosts.filter((entry) => entry.installed)) {
		output.writeHuman(`  ${host.hostName}`)
		output.writeHuman(`    Extension ID: ${host.extensionId ?? '(unknown)'}`)
		output.writeHuman(`    Argus path:   ${host.argusPath ?? '(unknown)'}`)
	}
	output.writeHuman('')
}
