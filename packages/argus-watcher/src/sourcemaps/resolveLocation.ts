import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping'
import type { SourceMapInput } from '@jridgewell/trace-mapping'

type GeneratedLocation = {
	file: string | null
	line: number | null
	column: number | null
}

type ResolvedLocation = {
	file: string
	line: number
	column: number
}

const traceMapCache = new Map<string, TraceMap | null>()
const pendingTraceMaps = new Map<string, Promise<TraceMap | null>>()

export const resolveSourcemappedLocation = async (location: GeneratedLocation): Promise<ResolvedLocation | null> => {
	if (!location.file) {
		return null
	}
	if (location.line == null || location.column == null) {
		return null
	}

	const scriptUrl = normalizeHttpUrl(location.file)
	if (!scriptUrl) {
		return null
	}

	const traceMap = await getTraceMap(scriptUrl)
	if (!traceMap) {
		return null
	}

	return resolveSourcemappedLocationWithMap(traceMap, {
		line: location.line,
		column: location.column,
	})
}

export const resolveSourcemappedLocationWithMap = (traceMap: TraceMap, location: { line: number; column: number }): ResolvedLocation | null => {
	if (location.line <= 0 || location.column <= 0) {
		return null
	}

	const position = originalPositionFor(traceMap, {
		line: location.line,
		column: Math.max(location.column - 1, 0),
	})

	if (!position.source || position.line == null || position.column == null) {
		return null
	}

	return {
		file: position.source,
		line: position.line,
		column: position.column + 1,
	}
}

const getTraceMap = async (scriptUrl: string): Promise<TraceMap | null> => {
	const cached = traceMapCache.get(scriptUrl)
	if (cached !== undefined) {
		return cached
	}

	const pending = pendingTraceMaps.get(scriptUrl)
	if (pending) {
		return pending
	}

	const promise = fetchTraceMap(scriptUrl)
		.then((traceMap) => {
			traceMapCache.set(scriptUrl, traceMap)
			return traceMap
		})
		.catch(() => {
			traceMapCache.set(scriptUrl, null)
			return null
		})
		.finally(() => {
			pendingTraceMaps.delete(scriptUrl)
		})

	pendingTraceMaps.set(scriptUrl, promise)
	return promise
}

const fetchTraceMap = async (scriptUrl: string): Promise<TraceMap | null> => {
	const response = await fetch(`${scriptUrl}.map`)
	if (!response.ok) {
		return null
	}

	const rawMap = (await response.json()) as SourceMapInput

	return new TraceMap(rawMap, scriptUrl)
}

const normalizeHttpUrl = (value: string): string | null => {
	let url: URL
	try {
		url = new URL(value)
	} catch {
		return null
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return null
	}

	return url.toString()
}
