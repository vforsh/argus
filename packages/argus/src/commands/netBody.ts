import { createOutput } from '../output/io.js'
import { renderNetworkBodyText } from '../output/net.js'
import { resolveWatcherOrExit } from '../watchers/requestWatcher.js'
import { fetchNetRequestBody } from './netRequestClient.js'
import { buildNetRequestLookupQuery } from './netRequestTarget.js'

export type NetBodyOptions = {
	request?: boolean
	json?: boolean
}

export const runNetBody = async (id: string | undefined, request: string, options: NetBodyOptions): Promise<void> => {
	const output = createOutput(options)
	const resolved = await resolveWatcherOrExit({ id }, output)
	if (!resolved) {
		return
	}

	const query = buildNetRequestLookupQuery(request, output)
	if (!query) {
		return
	}

	const response = await fetchNetRequestBody(resolved.watcher, query, options.request ? 'request' : 'response', output)
	if (!response || !response.ok) {
		return
	}

	if (options.json) {
		output.writeJson(response)
		return
	}

	const rendered = renderNetworkBodyText(response)
	if (rendered == null) {
		output.writeWarn('Body is base64-encoded binary data. Re-run with --json to inspect the raw payload.')
		process.exitCode = 1
		return
	}

	process.stdout.write(rendered.endsWith('\n') ? rendered : `${rendered}\n`)
}
