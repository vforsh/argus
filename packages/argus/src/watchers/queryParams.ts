import type { LogsQuery, MatchCase, NetQuery, NetScope, QueryValue } from '@vforsh/argus-core'
import { NET_SCOPES, normalizeMatchPatterns, normalizeQueryValue, parseDurationMs, toSearchParams } from '@vforsh/argus-core'
import { parseNumber } from '../cli/parse.js'

export { normalizeMatchPatterns }

type MatchCaseOptions = {
	ignoreCase?: boolean
	caseSensitive?: boolean
}

/**
 * Serialize a typed query fragment into an existing `URLSearchParams`.
 *
 * Callers layer route-specific params (`timeoutMs`, `part`, …) around these fragments, so each
 * key is replaced rather than appended to — repeated values within one fragment still stack.
 */
const applyQuery = (params: URLSearchParams, query: Record<string, QueryValue>): void => {
	const serialized = toSearchParams(query)
	for (const key of new Set(serialized.keys())) {
		params.delete(key)
		for (const value of serialized.getAll(key)) {
			params.append(key, value)
		}
	}
}

export const appendAfterLimitParams = (params: URLSearchParams, options: { after?: string; limit?: string; sinceEpoch?: string }): void => {
	applyQuery(params, {
		after: options.after,
		sinceEpoch: options.sinceEpoch,
		limit: parseNumber(options.limit),
	} satisfies LogsQuery)
}

export const appendSinceParam = (params: URLSearchParams, since?: string): { error?: string } => {
	const resolved = resolveSinceTimestamp(since)
	if (resolved.error) {
		return resolved
	}

	applyQuery(params, { sinceTs: resolved.sinceTs ?? undefined } satisfies Pick<LogsQuery, 'sinceTs'>)
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
	const normalizedMatch = normalizeMatchPatterns(options.match)
	if (normalizedMatch.error) {
		return { error: 'Invalid --match value: empty pattern.' }
	}

	applyQuery(params, {
		levels: options.levels,
		match: normalizedMatch.patterns,
		matchCase: resolveMatchCase(options),
		source: options.source,
	} satisfies LogsQuery)

	return {}
}

/** CLI-facing shape of the network filter flags, before validation. */
export type NetFilterCliOptions = {
	grep?: string
	host?: string[]
	method?: string[]
	status?: string[]
	resourceType?: string[]
	mime?: string[]
	scope?: string
	frame?: string
	party?: NetQuery['party']
	failedOnly?: boolean
	minDurationMs?: number
	minTransferBytes?: number
}

export const appendNetFilterParams = (params: URLSearchParams, options: NetFilterCliOptions): { error?: string } => {
	const scope = resolveNetScope(options.scope)
	if (scope.error) {
		return scope
	}

	applyQuery(params, {
		grep: options.grep,
		host: options.host,
		method: options.method,
		status: options.status,
		resourceType: options.resourceType,
		mime: options.mime,
		scope: scope.value,
		frame: options.frame,
		party: options.party,
		failedOnly: options.failedOnly,
		minDurationMs: options.minDurationMs,
		minTransferBytes: options.minTransferBytes,
	} satisfies NetQuery)

	return {}
}

export const appendNetIgnoreParams = (params: URLSearchParams, options: { ignoreHost?: string[]; ignorePattern?: string[] }): { error?: string } => {
	const hosts = normalizeRepeatedValues(options.ignoreHost)
	if (hosts.error) {
		return hosts
	}

	const patterns = normalizeRepeatedValues(options.ignorePattern)
	if (patterns.error) {
		return patterns
	}

	applyQuery(params, { ignoreHost: hosts.values, ignorePattern: patterns.values } satisfies NetQuery)
	return {}
}

export const resolveMatchCase = (options: MatchCaseOptions): MatchCase | undefined => {
	if (options.caseSensitive) {
		return 'sensitive'
	}
	if (options.ignoreCase) {
		return 'insensitive'
	}
	return undefined
}

/** Reject an unknown `--scope` here rather than round-tripping it to the watcher for a 400. */
const resolveNetScope = (value?: string): { value?: NetScope; error?: string } => {
	const normalized = normalizeQueryValue(value)
	if (!normalized) {
		return {}
	}

	if (!(NET_SCOPES as readonly string[]).includes(normalized)) {
		return { error: `Invalid --scope value: ${value}. Expected one of: ${NET_SCOPES.join(', ')}.` }
	}

	return { value: normalized as NetScope }
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
