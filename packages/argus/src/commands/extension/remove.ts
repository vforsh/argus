import { createOutput } from '../../output/io.js'
import { getPlatform, removeNativeHosts, shortenPath } from './nativeHost.js'

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

	const removedHosts = removeNativeHosts(platform)

	const manifestRemoved = removedHosts.some((host) => host.manifestRemoved)
	const wrapperRemoved = removedHosts.some((host) => host.wrapperRemoved)

	if (options.json) {
		output.writeJson({
			success: true,
			manifestRemoved,
			wrapperRemoved,
			hosts: removedHosts,
		})
	} else {
		output.writeHuman('')
		if (manifestRemoved || wrapperRemoved) {
			output.writeHuman('Native messaging hosts removed')
			output.writeHuman('')
			for (const host of removedHosts) {
				if (host.manifestRemoved) {
					output.writeHuman(`  Removed manifest: ${shortenPath(host.manifestPath)}`)
				}
				if (host.wrapperRemoved) {
					output.writeHuman(`  Removed wrapper:  ${shortenPath(host.wrapperPath)}`)
				}
			}
		} else {
			output.writeHuman('Native messaging hosts were not installed')
			output.writeHuman('')
			for (const host of removedHosts) {
				output.writeHuman(`  Manifest not found: ${shortenPath(host.manifestPath)}`)
				output.writeHuman(`  Wrapper not found:  ${shortenPath(host.wrapperPath)}`)
			}
		}
		output.writeHuman('')
	}
}
