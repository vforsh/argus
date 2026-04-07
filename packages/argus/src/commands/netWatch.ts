import type { NetResponse } from '@vforsh/argus-core'
import { captureNetWindow, parseNetCaptureOptions, type NetCaptureOptions } from './netCapture.js'
import { formatWatcherTransportError, resolveWatcherOrExit } from '../watchers/requestWatcher.js'
import { createOutput } from '../output/io.js'
import { formatNetworkRequest } from '../output/net.js'

export type NetWatchOptions = NetCaptureOptions & {
	json?: boolean
}

export const runNetWatch = async (id: string | undefined, options: NetWatchOptions): Promise<void> => {
	const output = createOutput(options)
	const resolved = await resolveWatcherOrExit({ id }, output)
	if (!resolved) {
		return
	}

	const parsed = parseNetCaptureOptions(options, { defaultClear: true })
	if (parsed.error || !parsed.value) {
		output.writeWarn(parsed.error ?? 'Invalid net watch options.')
		process.exitCode = 2
		return
	}

	const { watcher } = resolved
	let cleared = 0
	let requests: NetResponse['requests']
	let timedOut = false
	try {
		const captured = await captureNetWindow(watcher, options, parsed.value)
		cleared = captured.cleared
		requests = captured.requests
		timedOut = captured.timedOut
	} catch (error) {
		output.writeWarn(formatWatcherTransportError(watcher, error))
		process.exitCode = 1
		return
	}

	if (options.json) {
		output.writeJson({
			ok: true,
			cleared,
			reloaded: options.reload === true,
			settleMs: parsed.value.settleMs,
			timedOut,
			requests,
			nextAfter: requests[requests.length - 1]?.id ?? 0,
		})
		return
	}

	if (requests.length === 0) {
		output.writeHuman(`no requests captured after ${parsed.value.settleMs}ms quiet window`)
		return
	}

	for (const request of requests) {
		output.writeHuman(formatNetworkRequest(request))
	}
	output.writeHuman(
		timedOut
			? `stopped after max timeout (${requests.length} requests collected; quiet window ${parsed.value.settleMs}ms not reached)`
			: `settled after ${parsed.value.settleMs}ms quiet window (${requests.length} requests)`,
	)
}
