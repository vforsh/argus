import type { LogsQuery, MatchCase, NetQuery } from '@vforsh/argus-core'
import { NET_PARTIES, NET_SCOPES, normalizeMatchPatterns, parseDurationMs, toSearchParams } from '@vforsh/argus-core'
import type { LogsOptions, NetOptions } from '../types.js'

/** Build the query string for the log listing and tail routes. */
export const buildLogsParams = (options: LogsOptions): URLSearchParams => {
	if (options.after != null && options.sinceEpoch != null) {
		throw new Error('Use either after or sinceEpoch, not both')
	}

	const query: LogsQuery = {
		after: options.after,
		sinceEpoch: options.sinceEpoch,
		limit: requireNonNegative('limit', options.limit),
		levels: normalizeLevels(options.levels),
		match: requireMatchPatterns(options.match),
		matchCase: requireMatchCase(options.matchCase),
		source: options.source,
		sinceTs: resolveSinceTs(options.since),
	}

	return toSearchParams(query)
}

/** Build the query string for the network listing and tail routes. */
export const buildNetParams = (options: NetOptions): URLSearchParams => {
	if (options.scope != null && options.frame != null) {
		throw new Error('Cannot combine scope and frame filters. Use one or the other.')
	}

	const query: NetQuery = {
		after: requireNonNegative('after', options.after),
		limit: requireNonNegative('limit', options.limit),
		sinceTs: resolveSinceTs(options.since),
		grep: options.grep,
		host: requireNonEmptyValues('host', options.host),
		method: requireNonEmptyValues('method', options.method),
		status: requireNonEmptyValues('status', options.status),
		resourceType: requireNonEmptyValues('resourceType', options.resourceType),
		mime: requireNonEmptyValues('mime', options.mime),
		scope: requireChoice('scope', options.scope, NET_SCOPES),
		frame: options.frame,
		party: requireChoice('party', options.party, NET_PARTIES),
		failedOnly: options.failedOnly,
		minDurationMs: requireNonNegative('minDurationMs', options.minDurationMs),
		minTransferBytes: requireNonNegative('minTransferBytes', options.minTransferBytes),
		ignoreHost: requireNonEmptyValues('ignoreHost', options.ignoreHost),
		ignorePattern: requireNonEmptyValues('ignorePattern', options.ignorePattern),
	}

	return toSearchParams(query)
}

const normalizeLevels = (levels?: string | string[]): string | undefined => {
	if (levels == null) {
		return undefined
	}

	if (!Array.isArray(levels)) {
		return levels
	}

	const normalized = levels.map((level) => level.trim()).filter(Boolean)
	return normalized.length > 0 ? normalized.join(',') : undefined
}

const requireMatchPatterns = (match?: string | string[]): string[] | undefined => {
	if (match == null) {
		return undefined
	}

	const result = normalizeMatchPatterns(Array.isArray(match) ? match : [match])
	if (result.error) {
		throw new Error(result.error)
	}

	return result.patterns
}

const requireMatchCase = (matchCase?: MatchCase): MatchCase | undefined =>
	requireChoice('matchCase', matchCase, ['sensitive', 'insensitive'] as const)

const resolveSinceTs = (value?: string | number): number | undefined => {
	if (value == null) {
		return undefined
	}

	const durationMs = typeof value === 'number' ? requireNonNegative('since', value) : parseDurationOrThrow(value)
	return durationMs == null ? undefined : Date.now() - durationMs
}

const parseDurationOrThrow = (value: string): number => {
	const duration = parseDurationMs(value)
	if (duration == null) {
		throw new Error(`Invalid since value: ${value}`)
	}
	return duration
}

const requireNonNegative = (label: string, value?: number): number | undefined => {
	if (value == null) {
		return undefined
	}

	if (!Number.isFinite(value) || value < 0) {
		throw new Error(`Invalid ${label} value: ${value}`)
	}

	return value
}

const requireNonEmptyValues = (label: string, values?: string[]): string[] | undefined => {
	if (!values || values.length === 0) {
		return undefined
	}

	for (const value of values) {
		if (!value.trim()) {
			throw new Error(`Invalid ${label} value: ${value}`)
		}
	}

	return values
}

const requireChoice = <T extends string>(label: string, value: string | undefined, allowed: readonly T[]): T | undefined => {
	if (value == null) {
		return undefined
	}

	if (!allowed.includes(value as T)) {
		throw new Error(`Invalid ${label} value: ${value}`)
	}

	return value as T
}
