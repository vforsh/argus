import { createOutput } from '../../output/io.js'
import { getPlatform, inspectNativeHosts } from './nativeHost.js'

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

	const hosts = inspectNativeHosts(platform)
	const configured = hosts.every((host) => host.configured)
	const extensionId = hosts.find((host) => host.extensionId)?.extensionId ?? null

	if (options.json) {
		output.writeJson({
			configured,
			hosts,
			extensionId,
		})
		if (!configured) {
			process.exitCode = 1
		}
		return
	}

	output.writeHuman('')
	if (configured) {
		output.writeHuman('Native messaging hosts are configured')
		output.writeHuman('')
		output.writeHuman(`  Extension ID: ${extensionId}`)
	} else {
		output.writeHuman('Native messaging hosts not configured')
		output.writeHuman('')
		for (const host of hosts) {
			output.writeHuman(`  ${host.hostName}`)
			output.writeHuman(`    Manifest: ${host.manifestExists ? (host.manifestValid ? 'exists' : 'exists, invalid') : 'not found'}`)
			output.writeHuman(
				`    Wrapper:  ${host.wrapperExists ? (host.wrapperExecutable ? 'exists, executable' : 'exists, not executable') : 'not found'}`,
			)
		}
		if (extensionId) {
			output.writeHuman(`  Extension ID: ${extensionId}`)
		}
		output.writeHuman('')
		output.writeHuman("Run 'argus extension setup <extensionId>' to install.")
		process.exitCode = 1
	}
	output.writeHuman('')
}
