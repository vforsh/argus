import { getPlatformOrFail } from './failures.js'
import { createOutput } from '../../output/io.js'
import { inspectNativeHosts, shortenPath } from './nativeHost.js'

export type ExtensionInfoOptions = {
	json?: boolean
}

export const runExtensionInfo = async (options: ExtensionInfoOptions): Promise<void> => {
	const output = createOutput(options)

	const platform = getPlatformOrFail(output)
	if (!platform) return

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
