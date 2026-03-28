import type { NetFilters } from '../../buffer/NetBuffer.js'
import { normalizeQueryValue } from '../httpUtils.js'

type ParsedNetFilters = NetFilters & {
	after: number
	limit: number
}

/**
 * Parse shared query params for network endpoints so list/tail stay in sync.
 */
export const parseNetRequestFilters = (
	searchParams: URLSearchParams,
	options: { after: number; limit: number; sinceTs?: number },
): ParsedNetFilters => ({
	after: options.after,
	limit: options.limit,
	sinceTs: options.sinceTs,
	grep: normalizeQueryValue(searchParams.get('grep')),
	ignoreHosts: normalizeRepeatedValues(searchParams.getAll('ignoreHost')),
	ignorePatterns: normalizeRepeatedValues(searchParams.getAll('ignorePattern')),
})

const normalizeRepeatedValues = (values: string[]): string[] | undefined => {
	const normalized = values.map((value) => normalizeQueryValue(value)).filter((value): value is string => value != null)
	return normalized.length > 0 ? normalized : undefined
}
