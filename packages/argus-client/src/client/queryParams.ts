import type { LogsOptions, NetOptions } from '../types.js'
import { parseDurationMs } from '../time/parseDurationMs.js'

export const buildLogsParams = (options: LogsOptions): URLSearchParams => {
	const params = new URLSearchParams()
	const after = normalizeNonNegativeNumber('after', options.after)
	if (after != null) {
		params.set('after', String(after))
	}

	const limit = normalizeNonNegativeNumber('limit', options.limit)
	if (limit != null) {
		params.set('limit', String(limit))
	}

	const levels = normalizeLevels(options.levels)
	if (levels) {
		params.set('levels', levels)
	}

	const match = normalizeMatch(options.match)
	if (match) {
		for (const pattern of match) {
			params.append('match', pattern)
		}
	}

	const matchCase = normalizeMatchCase(options.matchCase)
	if (matchCase) {
		params.set('matchCase', matchCase)
	}

	const source = normalizeQueryValue(options.source)
	if (source) {
		params.set('source', source)
	}

	const sinceTs = resolveSinceTs(options.since)
	if (sinceTs != null) {
		params.set('sinceTs', String(sinceTs))
	}

	return params
}

export const buildNetParams = (options: NetOptions): URLSearchParams => {
	const params = new URLSearchParams()
	const after = normalizeNonNegativeNumber('after', options.after)
	if (after != null) {
		params.set('after', String(after))
	}

	const limit = normalizeNonNegativeNumber('limit', options.limit)
	if (limit != null) {
		params.set('limit', String(limit))
	}

	const sinceTs = resolveSinceTs(options.since)
	if (sinceTs != null) {
		params.set('sinceTs', String(sinceTs))
	}

	const grep = normalizeQueryValue(options.grep)
	if (grep) {
		params.set('grep', grep)
	}

	appendRepeatedQueryValues(params, 'ignoreHost', options.ignoreHost)
	appendRepeatedQueryValues(params, 'ignorePattern', options.ignorePattern)

	return params
}

const normalizeLevels = (levels?: string | string[]): string | undefined => {
	if (levels == null) {
		return undefined
	}

	if (Array.isArray(levels)) {
		const normalized = levels.map((level) => level.trim()).filter(Boolean)
		if (normalized.length === 0) {
			return undefined
		}
		return normalized.join(',')
	}

	const trimmed = levels.trim()
	return trimmed ? trimmed : undefined
}

const normalizeMatch = (match?: string | string[]): string[] | undefined => {
	if (match == null) {
		return undefined
	}

	const values = Array.isArray(match) ? match : [match]
	const normalized = values.map((value) => value.trim())
	if (normalized.some((value) => value.length === 0)) {
		throw new Error('Invalid match value: empty pattern.')
	}

	return normalized
}

const normalizeMatchCase = (matchCase?: 'sensitive' | 'insensitive'): 'sensitive' | 'insensitive' | undefined => {
	if (matchCase == null) {
		return undefined
	}

	if (matchCase !== 'sensitive' && matchCase !== 'insensitive') {
		throw new Error(`Invalid matchCase value: ${matchCase}`)
	}

	return matchCase
}

const resolveSinceTs = (value?: string | number): number | undefined => {
	if (value == null) {
		return undefined
	}

	const durationMs = typeof value === 'number' ? normalizeNonNegativeNumber('since', value) : parseDurationOrThrow(value)
	if (durationMs == null) {
		return undefined
	}

	return Date.now() - durationMs
}

const normalizeQueryValue = (value?: string): string | undefined => {
	if (value == null) {
		return undefined
	}

	const trimmed = value.trim()
	return trimmed ? trimmed : undefined
}

const appendRepeatedQueryValues = (params: URLSearchParams, key: string, values?: string[]): void => {
	if (!values || values.length === 0) {
		return
	}

	for (const value of values) {
		const normalized = normalizeQueryValue(value)
		if (!normalized) {
			throw new Error(`Invalid ${key} value: ${value}`)
		}
		params.append(key, normalized)
	}
}

const parseDurationOrThrow = (value: string): number => {
	const duration = parseDurationMs(value)
	if (duration == null) {
		throw new Error(`Invalid since value: ${value}`)
	}
	return duration
}

const normalizeNonNegativeNumber = (label: string, value?: number): number | undefined => {
	if (value == null) {
		return undefined
	}

	if (!Number.isFinite(value) || value < 0) {
		throw new Error(`Invalid ${label} value: ${value}`)
	}

	return value
}
