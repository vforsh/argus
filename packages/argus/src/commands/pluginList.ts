import { getPluginLoadReport } from '../cli/plugins/registerPlugins.js'
import { createOutput } from '../output/io.js'

export type PluginListOptions = {
	json?: boolean
	discovery?: boolean
}

export const runPluginList = (options: PluginListOptions): void => {
	const output = createOutput(options)
	const report = getPluginLoadReport()

	if (options.json) {
		output.writeJson(report)
		return
	}

	if (report.entries.length === 0) {
		output.writeHuman('No plugins configured for this invocation.')
		return
	}

	for (const entry of report.entries) {
		const spec = entry.alias ? `${entry.alias} -> ${entry.resolvedSpec}` : entry.spec
		if (options.discovery) {
			const discovery = entry.discovery
			output.writeHuman(`${entry.source}\t${spec}\t${discovery.registration} (${discovery.reason})`)
			output.writeHuman(`  resolved: ${discovery.resolvedPath ?? entry.url ?? 'unresolved'}`)
			output.writeHuman(`  manifest: ${discovery.manifestStatus} (${discovery.manifestSource ?? 'none'}); compatibility: ${discovery.compatibility}`)
			output.writeHuman(`  discovery: resolve ${discovery.timings.resolveMs.toFixed(2)}ms, manifest ${discovery.timings.manifestMs.toFixed(2)}ms`)
			if (discovery.metadataError) output.writeHuman(`  metadata: ${discovery.metadataError}`)
			if (entry.status === 'failed') output.writeHuman(`  failed: ${entry.error}`)
			continue
		}
		if (entry.status === 'failed') {
			output.writeHuman(`${entry.source}\t${spec}\tfailed\t${entry.error}`)
			continue
		}

		const version = entry.version ? ` v${entry.version}` : ''
		const commands = entry.commands.length > 0 ? ` commands: ${entry.commands.join(', ')}` : ''
		const description = entry.description ? ` — ${entry.description}` : ''
		output.writeHuman(`${entry.source}\t${entry.name}${version}\t${spec}\tloaded${commands}${description}`)
	}
}
