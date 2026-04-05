import { normalizeQueryValue, parseNumber } from '../cli/parse.js'
import { parseDurationMs } from '../time.js'

type MatchCaseOptions = {
	ignoreCase?: boolean
	caseSensitive?: boolean
}

export const appendAfterLimitParams = (params: URLSearchParams, options: { after?: string; limit?: string }): void => {
	const after = parseNumber(options.after)
	if (after != null) {
		params.set('after', String(after))
	}

	const limit = parseNumber(options.limit)
	if (limit != null) {
		params.set('limit', String(limit))
	}
}

export const appendSinceParam = (params: URLSearchParams, since?: string): { error?: string } => {
	const resolved = resolveSinceTimestamp(since)
	if (resolved.error) {
		return resolved
	}
	if (resolved.sinceTs == null) {
		return {}
	}

	params.set('sinceTs', String(resolved.sinceTs))
	return {}
}

export const resolveSinceTimestamp = (since?: string): { sinceTs: number | null; error?: string } => {
	if (!since) {
		return { sinceTs: null }
	}

	const duration = parseDurationMs(since)
	if (!duration) {
		return { sinceTs: null, error: `Invalid --since value: ${since}` }
	}

	return { sinceTs: Date.now() - duration }
}

export const appendLogFilterParams = (
	params: URLSearchParams,
	options: {
		levels?: string
		match?: string[]
		source?: string
		ignoreCase?: boolean
		caseSensitive?: boolean
	},
): { error?: string } => {
	if (options.levels) {
		params.set('levels', options.levels)
	}

	const normalizedMatch = normalizeMatchPatterns(options.match)
	if (normalizedMatch.error) {
		return normalizedMatch
	}
	for (const pattern of normalizedMatch.patterns) {
		params.append('match', pattern)
	}

	const matchCase = resolveMatchCase(options)
	if (matchCase) {
		params.set('matchCase', matchCase)
	}

	const source = normalizeQueryValue(options.source)
	if (source) {
		params.set('source', source)
	}

	return {}
}

export const appendNetFilterParams = (
	params: URLSearchParams,
	options: {
		grep?: string
		host?: string[]
		method?: string[]
		status?: string[]
		resourceType?: string[]
		mime?: string[]
		scope?: string
		frame?: string
		party?: 'first' | 'third'
		failedOnly?: boolean
		minDurationMs?: number
		minTransferBytes?: number
	},
): void => {
	const grep = normalizeQueryValue(options.grep)
	if (grep) {
		params.set('grep', grep)
	}

	appendRepeatedParams(params, 'host', options.host)
	appendRepeatedParams(params, 'method', options.method)
	appendRepeatedParams(params, 'status', options.status)
	appendRepeatedParams(params, 'resourceType', options.resourceType)
	appendRepeatedParams(params, 'mime', options.mime)

	const scope = normalizeQueryValue(options.scope)
	if (scope) {
		params.set('scope', scope)
	}

	const frame = normalizeQueryValue(options.frame)
	if (frame) {
		params.set('frame', frame)
	}

	if (options.party) {
		params.set('party', options.party)
	}

	if (options.failedOnly) {
		params.set('failedOnly', '1')
	}

	if (options.minDurationMs != null) {
		params.set('minDurationMs', String(options.minDurationMs))
	}

	if (options.minTransferBytes != null) {
		params.set('minTransferBytes', String(options.minTransferBytes))
	}
}

export const appendNetIgnoreParams = (params: URLSearchParams, options: { ignoreHost?: string[]; ignorePattern?: string[] }): { error?: string } => {
	const hosts = normalizeRepeatedValues(options.ignoreHost)
	if (hosts.error) {
		return hosts
	}
	for (const value of hosts.values) {
		params.append('ignoreHost', value)
	}

	const patterns = normalizeRepeatedValues(options.ignorePattern)
	if (patterns.error) {
		return patterns
	}
	for (const value of patterns.values) {
		params.append('ignorePattern', value)
	}

	return {}
}

export const normalizeMatchPatterns = (match?: string[]): { patterns: string[]; error?: string } => {
	if (!match || match.length === 0) {
		return { patterns: [] }
	}

	const patterns = match.map((value) => value.trim())
	if (patterns.some((value) => value.length === 0)) {
		return { patterns: [], error: 'Invalid --match value: empty pattern.' }
	}

	return { patterns }
}

export const resolveMatchCase = (options: MatchCaseOptions): 'sensitive' | 'insensitive' | undefined => {
	if (options.caseSensitive) {
		return 'sensitive'
	}
	if (options.ignoreCase) {
		return 'insensitive'
	}
	return undefined
}

const normalizeRepeatedValues = (values?: string[]): { values: string[]; error?: string } => {
	if (!values || values.length === 0) {
		return { values: [] }
	}

	const normalized = values.map((value) => value.trim())
	if (normalized.some((value) => value.length === 0)) {
		return { values: [], error: 'Invalid empty filter value.' }
	}

	return { values: normalized }
}

const appendRepeatedParams = (params: URLSearchParams, key: string, values?: string[]): void => {
	const normalized = normalizeRepeatedValues(values)
	if (normalized.error) {
		return
	}

	for (const value of normalized.values) {
		params.append(key, value)
	}
}
