import { parseDurationMs } from '../time.js'
import { appendAfterLimitParams, appendNetFilterParams, appendNetIgnoreParams, appendSinceParam } from '../watchers/queryParams.js'

export type NetCliFilterOptions = {
	since?: string
	grep?: string
	ignoreHost?: string[]
	ignorePattern?: string[]
}

export type NetCliListOptions = NetCliFilterOptions & {
	after?: string
	limit?: string
}

export const validateNetCommandOptions = (options: NetCliFilterOptions): { error?: string } =>
	appendNetCommandParams(new URLSearchParams(), options, { includeAfter: false, includeLimit: false })

export const appendNetCommandParams = (
	params: URLSearchParams,
	options: NetCliListOptions,
	config: { includeAfter?: boolean; includeLimit?: boolean } = {},
): { error?: string } => {
	if (config.includeAfter !== false) {
		const afterParams = new URLSearchParams()
		appendAfterLimitParams(afterParams, { after: options.after })
		for (const [key, value] of afterParams) {
			params.set(key, value)
		}
	}

	if (config.includeLimit !== false) {
		const limitParams = new URLSearchParams()
		appendAfterLimitParams(limitParams, { limit: options.limit })
		for (const [key, value] of limitParams) {
			params.set(key, value)
		}
	}

	appendNetFilterParams(params, options)

	const ignore = appendNetIgnoreParams(params, options)
	if (ignore.error) {
		return ignore
	}

	return appendSinceParam(params, options.since)
}

export const parseSettleDurationMs = (value: string | undefined, fallback = '3s'): { value?: number; error?: string } => {
	const raw = value ?? fallback
	const parsed = parseDurationMs(raw)
	if (parsed == null || parsed < 1) {
		return { error: `Invalid --settle value: ${raw}` }
	}
	return { value: Math.round(parsed) }
}
