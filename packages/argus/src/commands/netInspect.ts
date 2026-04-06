import type { NetCliFilterOptions } from './netShared.js'
import type { NetRequestBodyPart, NetRequestBodyResponse, NetworkRequestDetail } from '@vforsh/argus-core'
import { createOutput } from '../output/io.js'
import { formatNetworkRequestInspect, renderNetworkBodyText } from '../output/net.js'
import { resolveWatcherOrExit, writeErrorResponse } from '../watchers/requestWatcher.js'
import { appendNetCommandParams } from './netShared.js'
import { captureNetWindow, parseNetCaptureOptions, type NetCaptureOptions } from './netCapture.js'
import { fetchNetRequestBody, fetchNetRequestDetail, fetchNetRequestSummaries } from './netRequestClient.js'

export type NetInspectOptions = NetCaptureOptions & {
	request?: boolean
	response?: boolean
	json?: boolean
}

type NetInspectResult = {
	ok: true
	pattern: string
	cleared: number
	reloaded: boolean
	settleMs: number
	timedOut: boolean
	matchedCount: number
	request: NetworkRequestDetail
	requestBody: NetRequestBodyResponse | null
	responseBody: NetRequestBodyResponse | null
}

type InspectBodyFetchResult = {
	body: NetRequestBodyResponse | null
	abort: boolean
}

/**
 * Happy-path network inspection:
 * capture a fresh request window, pick the newest URL match, then fetch detail + bodies in one go.
 */
export const runNetInspect = async (id: string | undefined, pattern: string, options: NetInspectOptions): Promise<void> => {
	const output = createOutput(options)
	const normalizedPattern = pattern.trim()
	if (!normalizedPattern) {
		writeInspectError(output, 'invalid_request', 'pattern is required', 2)
		return
	}

	const resolved = await resolveWatcherOrExit({ id }, output)
	if (!resolved) {
		return
	}

	const captureOptions = parseNetCaptureOptions(
		{
			...options,
			grep: normalizedPattern,
			reload: options.reload ?? true,
		},
		{ defaultClear: true },
	)
	if (captureOptions.error || !captureOptions.value) {
		writeInspectError(output, 'invalid_request', captureOptions.error ?? 'Invalid net inspect options.', 2)
		return
	}

	const captureStartedAt = Date.now()
	const captured = await captureNetWindow(resolved.watcher, buildInspectSettleFilters(options), captureOptions.value).catch((error) => {
		output.writeWarn(`${resolved.watcher.id}: failed to inspect network (${error instanceof Error ? error.message : String(error)})`)
		process.exitCode = 1
		return null
	})
	if (!captured) {
		return
	}

	const matchedRequests = await fetchInspectedRequests(resolved.watcher, options, normalizedPattern, captureStartedAt, output)
	if (!matchedRequests) {
		return
	}

	const selected = matchedRequests[matchedRequests.length - 1]
	if (!selected) {
		writeInspectNoMatch(output, normalizedPattern, captureOptions.value.settleMs, captured.timedOut)
		return
	}

	const query = createNetRequestIdQuery(selected.id)

	const detail = await fetchNetRequestDetail(resolved.watcher, query, output)
	if (!detail) {
		return
	}

	const parts = resolveInspectBodyParts(options)
	const requestBody = parts.includes('request')
		? await fetchInspectableBody(resolved.watcher, query, detail, 'request', output)
		: { body: null, abort: false }
	if (requestBody.abort) {
		return
	}

	const responseBody = parts.includes('response')
		? await fetchInspectableBody(resolved.watcher, query, detail, 'response', output)
		: { body: null, abort: false }
	if (responseBody.abort) {
		return
	}

	const result: NetInspectResult = {
		ok: true,
		pattern: normalizedPattern,
		cleared: captured.cleared,
		reloaded: captureOptions.value.shouldReload,
		settleMs: captureOptions.value.settleMs,
		timedOut: captured.timedOut,
		matchedCount: matchedRequests.length,
		request: detail,
		requestBody: requestBody.body,
		responseBody: responseBody.body,
	}

	if (options.json) {
		output.writeJson(result)
		return
	}

	for (const line of formatNetworkRequestInspect(detail, { matchedCount: matchedRequests.length, pattern: normalizedPattern })) {
		output.writeHuman(line)
	}
	if (parts.includes('request')) {
		writeBodySection(output, 'Request body', requestBody.body, detail.body.request)
	}
	if (parts.includes('response')) {
		writeBodySection(output, 'Response body', responseBody.body, detail.body.response)
	}
}

const fetchInspectableBody = async (
	watcher: { id: string; host: string; port: number },
	query: URLSearchParams,
	detail: NetworkRequestDetail,
	part: NetRequestBodyPart,
	output: ReturnType<typeof createOutput>,
): Promise<InspectBodyFetchResult> => {
	if (!detail.body[part]) {
		return { body: null, abort: false }
	}

	const response = await fetchNetRequestBody(watcher, query, part, output, { writeApiErrors: false })
	if (!response) {
		return { body: null, abort: true }
	}

	if (!response.ok) {
		if (response.error.code === 'body_not_available') {
			return { body: null, abort: false }
		}
		writeErrorResponse(response, output)
		return { body: null, abort: true }
	}

	return { body: response, abort: false }
}

const resolveInspectBodyParts = (options: NetInspectOptions): NetRequestBodyPart[] => {
	const parts: NetRequestBodyPart[] = []
	if (options.request) {
		parts.push('request')
	}
	if (options.response) {
		parts.push('response')
	}
	return parts.length > 0 ? parts : ['request', 'response']
}

const buildInspectFilters = (options: NetInspectOptions, pattern: string): NetCliFilterOptions => ({
	grep: pattern,
	host: options.host,
	method: options.method,
	status: options.status,
	resourceType: options.resourceType,
	mime: options.mime,
	scope: options.scope,
	frame: options.frame,
	firstParty: options.firstParty,
	thirdParty: options.thirdParty,
	failedOnly: options.failedOnly,
	slowOver: options.slowOver,
	largeOver: options.largeOver,
	ignoreHost: options.ignoreHost,
	ignorePattern: options.ignorePattern,
})

const createNetRequestIdQuery = (id: number): URLSearchParams => new URLSearchParams({ id: String(id) })

/**
 * `net inspect` waits for the page to go quiet, not just for matching requests to stop.
 * That keeps late boot requests observable even when the app spends its first few seconds
 * on unrelated assets or setup calls before hitting the endpoint we care about.
 */
const buildInspectSettleFilters = (options: NetInspectOptions): NetCliFilterOptions => ({
	scope: options.scope,
	frame: options.frame,
	firstParty: options.firstParty,
	thirdParty: options.thirdParty,
	ignoreHost: options.ignoreHost,
	ignorePattern: options.ignorePattern,
})

const fetchInspectedRequests = async (
	watcher: { id: string; host: string; port: number },
	options: NetInspectOptions,
	pattern: string,
	captureStartedAt: number,
	output: ReturnType<typeof createOutput>,
): Promise<Array<{ id: number }> | null> => {
	const query = new URLSearchParams()
	const appended = appendNetCommandParams(
		query,
		{
			...buildInspectFilters(options, pattern),
			limit: '5000',
		},
		{ includeAfter: false },
	)
	if (appended.error) {
		writeInspectError(output, 'invalid_request', appended.error, 2)
		return null
	}
	query.set('sinceTs', String(captureStartedAt))

	return await fetchNetRequestSummaries(watcher, query, output)
}

const writeBodySection = (output: ReturnType<typeof createOutput>, title: string, body: NetRequestBodyResponse | null, available: boolean): void => {
	output.writeHuman('')
	if (!available || !body) {
		output.writeHuman(`${title}: not available`)
		return
	}

	output.writeHuman(`${title}${body.mimeType ? ` (${body.mimeType})` : ''}:`)
	const rendered = renderNetworkBodyText(body)
	if (rendered == null) {
		output.writeHuman('[base64-encoded binary data; re-run with --json for the raw payload]')
		return
	}

	process.stdout.write(prettifyJsonLikeBody(rendered))
}

const prettifyJsonLikeBody = (value: string): string => {
	const trimmed = value.trim()
	if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
		return value.endsWith('\n') ? value : `${value}\n`
	}

	try {
		return `${JSON.stringify(JSON.parse(trimmed), null, 2)}\n`
	} catch {
		return value.endsWith('\n') ? value : `${value}\n`
	}
}

const writeInspectError = (output: ReturnType<typeof createOutput>, code: string, message: string, exitCode: number): void => {
	if (output.json) {
		output.writeJson({ ok: false, error: { code, message } })
	} else {
		output.writeWarn(message)
	}
	process.exitCode = exitCode
}

const writeInspectNoMatch = (output: ReturnType<typeof createOutput>, pattern: string, settleMs: number, timedOut: boolean): void => {
	const message = timedOut
		? `No requests matched "${pattern}" before the max timeout expired (quiet window ${settleMs}ms).`
		: `No requests matched "${pattern}" after the ${settleMs}ms quiet window.`
	writeInspectError(output, 'not_found', message, 1)
}
