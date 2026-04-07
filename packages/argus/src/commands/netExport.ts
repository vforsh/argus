import fs from 'node:fs/promises'
import path from 'node:path'
import type { NetRequestsResponse, NetworkRequestDetail } from '@vforsh/argus-core'
import type { NetCliFilterOptions } from './netShared.js'
import { captureNetWindow, parseNetCaptureOptions, type NetCaptureOptions } from './netCapture.js'
import { appendNetCommandParams, validateNetCommandOptions } from './netShared.js'
import { buildHarFromNetworkRequests } from '../net/har.js'
import { createOutput } from '../output/io.js'
import { resolvePath } from '../utils/paths.js'
import { fetchWatcherJson, formatWatcherTransportError, resolveWatcherOrExit } from '../watchers/requestWatcher.js'

const NET_EXPORT_PAGE_LIMIT = 5_000

type ValidatedNetExportOptions = {
	out: string
	format: 'har'
	capture?: NonNullable<ReturnType<typeof parseNetCaptureOptions>['value']>
}

export type NetExportOptions = NetCaptureOptions & {
	json?: boolean
	out?: string
	format?: string
}

export const runNetExport = async (id: string | undefined, options: NetExportOptions): Promise<void> => {
	const output = createOutput(options)
	const validated = validateNetExportOptions(options)
	if (validated.error || !validated.value) {
		output.writeWarn(validated.error ?? 'Invalid net export options.')
		process.exitCode = 2
		return
	}

	const resolved = await resolveWatcherOrExit({ id }, output)
	if (!resolved) {
		return
	}

	const { watcher } = resolved
	const exportOptions = validated.value
	let cleared = 0
	let timedOut = false
	let requests: NetworkRequestDetail[]

	try {
		if (exportOptions.capture) {
			const captured = await captureNetWindow(watcher, options, exportOptions.capture)
			cleared = captured.cleared
			timedOut = captured.timedOut
		}

		requests = await fetchAllNetworkRequestDetails(watcher, options)
	} catch (error) {
		output.writeWarn(formatWatcherTransportError(watcher, error))
		process.exitCode = 1
		return
	}

	const har = buildHarFromNetworkRequests(requests)
	const outPath = resolvePath(exportOptions.out)

	try {
		await writeHarFile(outPath, har)
	} catch (error) {
		output.writeWarn(`Failed to write HAR file: ${error instanceof Error ? error.message : String(error)}`)
		process.exitCode = 1
		return
	}

	if (options.json) {
		output.writeJson({
			ok: true,
			format: exportOptions.format,
			out: outPath,
			requestCount: requests.length,
			reloaded: exportOptions.capture?.shouldReload ?? false,
			cleared,
			timedOut,
		})
		return
	}

	output.writeHuman(formatHarSavedMessage(outPath, requests.length, timedOut))
}

const validateNetExportOptions = (options: NetExportOptions): { value?: ValidatedNetExportOptions; error?: string } => {
	const out = options.out?.trim()
	if (!out) {
		return { error: 'Missing --out value.' }
	}

	const format = (options.format?.trim().toLowerCase() ?? 'har') as string
	if (format !== 'har') {
		return { error: `Unsupported --format value: ${options.format}. Only "har" is supported right now.` }
	}

	if (options.reload) {
		const capture = parseNetCaptureOptions(options, { defaultClear: true })
		if (capture.error || !capture.value) {
			return { error: capture.error ?? 'Invalid capture options.' }
		}
		return { value: { out, format: 'har', capture: capture.value } }
	}

	const validation = validateNetCommandOptions(options)
	if (validation.error) {
		return { error: validation.error }
	}

	return { value: { out, format: 'har' } }
}

const writeHarFile = async (outPath: string, har: ReturnType<typeof buildHarFromNetworkRequests>): Promise<void> => {
	await fs.mkdir(path.dirname(outPath), { recursive: true })
	await fs.writeFile(outPath, `${JSON.stringify(har, null, 2)}\n`, 'utf8')
}

const formatHarSavedMessage = (outPath: string, requestCount: number, timedOut: boolean): string => {
	if (timedOut) {
		return `HAR saved: ${outPath} (${requestCount} requests, max timeout reached before quiet window)`
	}

	return `HAR saved: ${outPath} (${requestCount} requests)`
}

const fetchAllNetworkRequestDetails = async (
	watcher: { host: string; port: number },
	options: NetCliFilterOptions,
): Promise<NetworkRequestDetail[]> => {
	const requests: NetworkRequestDetail[] = []
	let after = 0
	const baseParams = createNetRequestsBaseParams(options)

	while (true) {
		const params = new URLSearchParams(baseParams)
		params.set('after', String(after))
		params.set('limit', String(NET_EXPORT_PAGE_LIMIT))

		const response = await fetchWatcherJson<NetRequestsResponse>(watcher, {
			path: '/net/requests',
			query: params,
			timeoutMs: 5_000,
		})
		if (response.requests.length === 0) {
			return requests
		}

		requests.push(...response.requests)
		after = response.nextAfter
	}
}

const createNetRequestsBaseParams = (options: NetCliFilterOptions): URLSearchParams => {
	const params = new URLSearchParams()
	const query = appendNetCommandParams(params, options, { includeAfter: false, includeLimit: false })
	if (query.error) {
		throw new Error(query.error)
	}
	return params
}
