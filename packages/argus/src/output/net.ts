import type {
	NetRequestBodyResponse,
	NetworkInitiatorStackFrame,
	NetworkRequestDetail,
	NetworkRequestSummary,
	NetworkTimingPhases,
} from '@vforsh/argus-core'

/** Format a network request summary for human output. */
export const formatNetworkRequest = (request: NetworkRequestSummary): string => {
	const status = request.status != null ? String(request.status) : request.errorText ? 'ERR' : '...'
	const duration = request.durationMs != null ? `${request.durationMs}ms` : ''
	const size = request.encodedDataLength != null ? `${request.encodedDataLength}b` : ''
	const parts = [request.method, status, duration, size, request.url].filter(Boolean)
	return parts.join(' ')
}

/** Render a detailed network request as human-readable lines. */
export const formatNetworkRequestDetail = (request: NetworkRequestDetail): string[] => {
	const lines = [`${request.method} ${formatStatus(request)} ${request.url}`, `Argus id: ${request.id}  requestId: ${request.requestId}`]

	const overview = [
		pair('Type', request.resourceType),
		pair('Mime', request.mimeType),
		pair('Bodies', formatBodies(request)),
		pair('Priority', request.priority),
		pair('Protocol', request.protocol),
		pair('Remote', formatRemote(request.remoteAddress, request.remotePort)),
		pair('Duration', formatMs(request.durationMs)),
		pair('Transfer', formatBytes(request.encodedDataLength)),
		pair('Document', request.documentUrl),
		pair('Frame', request.frameId),
		pair('Loader', request.loaderId),
		pair('Cache', formatCacheFlags(request)),
	].filter((value): value is string => Boolean(value))

	lines.push(...overview)

	if (request.errorText) {
		lines.push(`Error: ${request.errorText}`)
	}

	if (request.redirects.length > 0) {
		lines.push('Redirects:')
		for (const hop of request.redirects) {
			lines.push(`  ${hop.status ?? 'n/a'} ${hop.fromUrl} -> ${hop.toUrl}${hop.statusText ? ` (${hop.statusText})` : ''}`)
		}
	}

	if (request.initiator) {
		lines.push(`Initiator: ${formatInitiator(request)}`)
		if (request.initiator.stack.length > 0) {
			lines.push('Initiator stack:')
			for (const frame of request.initiator.stack) {
				lines.push(`  ${formatStackFrame(frame)}`)
			}
		}
	}

	const timing = formatTiming(request.timingPhases)
	if (timing) {
		lines.push(`Timing: ${timing}`)
	}

	const requestHeaders = formatHeaders('Request headers', request.requestHeaders)
	if (requestHeaders) {
		lines.push(...requestHeaders)
	}

	const responseHeaders = formatHeaders('Response headers', request.responseHeaders)
	if (responseHeaders) {
		lines.push(...responseHeaders)
	}

	return lines
}

/** Render a compact request summary for `net inspect` before the body sections. */
export const formatNetworkRequestInspect = (request: NetworkRequestDetail, context?: { matchedCount?: number; pattern?: string }): string[] => {
	const lines = [`${request.method} ${formatStatus(request)} ${request.url}`, `Argus id: ${request.id}  requestId: ${request.requestId}`]

	if (context?.pattern) {
		const matchedLabel = context.matchedCount === 1 ? 'match' : 'matches'
		lines.push(`Pattern: "${context.pattern}" (${context?.matchedCount ?? 1} ${matchedLabel}; newest request shown)`)
	}

	const overview = [
		pair('Type', request.resourceType),
		pair('Mime', request.mimeType),
		pair('Bodies', formatBodies(request)),
		pair('Duration', formatMs(request.durationMs)),
		pair('Transfer', formatBytes(request.encodedDataLength)),
		pair('Frame', request.frameId),
		pair('Cache', formatCacheFlags(request)),
	].filter((value): value is string => Boolean(value))
	lines.push(...overview)

	const requestHeaders = formatHeaderSummary('Request headers', request.requestHeaders, REQUEST_SUMMARY_HEADERS)
	if (requestHeaders) {
		lines.push(requestHeaders)
	}

	const responseHeaders = formatHeaderSummary('Response headers', request.responseHeaders, RESPONSE_SUMMARY_HEADERS)
	if (responseHeaders) {
		lines.push(responseHeaders)
	}

	const timing = formatTiming(request.timingPhases)
	if (timing) {
		lines.push(`Timing: ${timing}`)
	}

	if (request.errorText) {
		lines.push(`Error: ${request.errorText}`)
	}

	return lines
}

/** Decode a body payload when it looks like text; returns null for likely-binary content. */
export const renderNetworkBodyText = (response: NetRequestBodyResponse): string | null => {
	if (!response.base64Encoded) {
		return response.body
	}

	if (!isTextMimeType(response.mimeType)) {
		return null
	}

	try {
		return Buffer.from(response.body, 'base64').toString('utf8')
	} catch {
		return null
	}
}

const formatStatus = (request: NetworkRequestDetail): string => {
	if (request.errorText) {
		return request.status != null ? `${request.status} ERR` : 'ERR'
	}
	if (request.status == null) {
		return 'unknown'
	}
	return request.statusText ? `${request.status} ${request.statusText}` : String(request.status)
}

const formatRemote = (address: string | null, port: number | null): string | null => {
	if (!address) {
		return null
	}
	return port != null ? `${address}:${port}` : address
}

const formatCacheFlags = (request: NetworkRequestDetail): string | null => {
	const flags = [
		request.servedFromCache ? 'servedFromCache' : null,
		request.fromDiskCache ? 'disk' : null,
		request.fromPrefetchCache ? 'prefetch' : null,
		request.fromServiceWorker ? `serviceWorker${request.serviceWorkerResponseSource ? `:${request.serviceWorkerResponseSource}` : ''}` : null,
	].filter((value): value is string => Boolean(value))

	return flags.length > 0 ? flags.join(', ') : null
}

const formatBodies = (request: NetworkRequestDetail): string | null => {
	const parts = [request.body.request ? 'request' : null, request.body.response ? 'response' : null].filter((value): value is string =>
		Boolean(value),
	)

	return parts.length > 0 ? parts.join(', ') : null
}

const formatInitiator = (request: NetworkRequestDetail): string => {
	const parts = [
		request.initiator?.type ?? 'unknown',
		request.initiator?.requestId ? `request:${request.initiator.requestId}` : null,
		request.initiator?.url,
		formatLocation(request.initiator?.lineNumber ?? null, request.initiator?.columnNumber ?? null),
	].filter((value): value is string => Boolean(value))

	return parts.join(' ')
}

const formatStackFrame = (frame: NetworkInitiatorStackFrame): string => {
	const location = formatLocation(frame.lineNumber, frame.columnNumber)
	const prefix = frame.functionName ? `${frame.functionName} ` : ''
	return `${prefix}${frame.url}${location ? ` ${location}` : ''}`
}

const formatTiming = (timing: NetworkTimingPhases | null): string | null => {
	if (!timing) {
		return null
	}

	const parts = [
		formatTimingPart('blocked', timing.blockedMs),
		formatTimingPart('dns', timing.dnsMs),
		formatTimingPart('connect', timing.connectMs),
		formatTimingPart('ssl', timing.sslMs),
		formatTimingPart('send', timing.sendMs),
		formatTimingPart('wait', timing.waitMs),
		formatTimingPart('download', timing.downloadMs),
		formatTimingPart('total', timing.totalMs),
	].filter((value): value is string => Boolean(value))

	return parts.length > 0 ? parts.join('  ') : null
}

const formatHeaders = (title: string, headers: Record<string, string> | undefined): string[] | null => {
	if (!headers || Object.keys(headers).length === 0) {
		return null
	}

	return [
		`${title}:`,
		...Object.entries(headers)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([name, value]) => `  ${name}: ${value}`),
	]
}

const formatHeaderSummary = (title: string, headers: Record<string, string> | undefined, names: string[]): string | null => {
	if (!headers) {
		return null
	}

	const selected = names
		.map((name) => {
			const value = getHeaderValue(headers, name)
			return value ? `${name}: ${value}` : null
		})
		.filter((value): value is string => Boolean(value))

	return selected.length > 0 ? `${title}: ${selected.join('  ')}` : null
}

const getHeaderValue = (headers: Record<string, string>, name: string): string | null => {
	for (const [headerName, value] of Object.entries(headers)) {
		if (headerName.toLowerCase() === name) {
			return value
		}
	}

	return null
}

const pair = (label: string, value: string | null | undefined, includeColon = true): string | null => {
	if (!value) {
		return null
	}
	return includeColon ? `${label}: ${value}` : `${label} ${value}`
}

const formatTimingPart = (label: string, value: number | null): string | null => {
	const formatted = formatMs(value)
	return formatted ? `${label} ${formatted}` : null
}

const formatLocation = (line: number | null, column: number | null): string | null => {
	if (line == null) {
		return null
	}
	return column != null ? `:${line}:${column}` : `:${line}`
}

const formatMs = (value: number | null): string | null => (value != null ? `${Math.round(value)}ms` : null)

const formatBytes = (value: number | null): string | null => {
	if (value == null) {
		return null
	}
	if (value < 1024) {
		return `${value} B`
	}
	if (value < 1024 * 1024) {
		return `${(value / 1024).toFixed(1)} KB`
	}
	return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

const isTextMimeType = (value: string | null): boolean => {
	if (!value) {
		return false
	}

	const mimeType = value.toLowerCase()
	return (
		mimeType.startsWith('text/') ||
		mimeType.includes('json') ||
		mimeType.includes('javascript') ||
		mimeType.includes('xml') ||
		mimeType.includes('x-www-form-urlencoded')
	)
}

const REQUEST_SUMMARY_HEADERS = ['content-type', 'content-length', 'origin', 'referer', 'authorization']
const RESPONSE_SUMMARY_HEADERS = ['content-type', 'content-length', 'content-encoding', 'cache-control', 'location', 'set-cookie']
