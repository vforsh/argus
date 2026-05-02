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
		const label = entry.status === 'loaded' ? `${entry.name} loaded` : 'failed'
		const detail = entry.status === 'loaded' ? entry.url : entry.error
		output.writeHuman(`${entry.source}\t${entry.spec}\t${label}\t${detail}`)
	}
}
