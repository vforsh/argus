import { createOutput } from '../output/io.js'
import { formatNetworkRequestDetail } from '../output/net.js'
import { resolveWatcherOrExit } from '../watchers/requestWatcher.js'
import { fetchNetRequestDetail } from './netRequestClient.js'
import { buildNetRequestLookupQuery } from './netRequestTarget.js'

export type NetShowOptions = {
	json?: boolean
}

export const runNetShow = async (id: string | undefined, request: string, options: NetShowOptions): Promise<void> => {
	const output = createOutput(options)
	const resolved = await resolveWatcherOrExit({ id }, output)
	if (!resolved) {
		return
	}

	const query = buildNetRequestLookupQuery(request, output)
	if (!query) {
		return
	}

	const detail = await fetchNetRequestDetail(resolved.watcher, query, output)
	if (!detail) {
		return
	}

	if (options.json) {
		output.writeJson(detail)
		return
	}

	for (const line of formatNetworkRequestDetail(detail)) {
		output.writeHuman(line)
	}
}
