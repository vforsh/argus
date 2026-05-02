import { getPluginLoadReport } from '../cli/plugins/registerPlugins.js'
import { createOutput } from '../output/io.js'

export type PluginListOptions = {
	json?: boolean
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
