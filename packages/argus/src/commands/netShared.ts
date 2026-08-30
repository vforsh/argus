import { parseDurationMs } from '@vforsh/argus-core'
import { fetchWatcherJson } from '../watchers/requestWatcher.js'
import { appendAfterLimitParams, appendNetFilterParams, appendNetIgnoreParams, appendSinceParam } from '../watchers/queryParams.js'

export type NetCliFilterOptions = {
	since?: string
	grep?: string
	ignoreHost?: string[]
	ignorePattern?: string[]
	host?: string[]
	method?: string[]
	status?: string[]
	resourceType?: string[]
	mime?: string[]
	scope?: string
	frame?: string
	firstParty?: boolean
	thirdParty?: boolean
	failedOnly?: boolean
	slowOver?: string
	largeOver?: string
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
	appendAfterLimitParams(params, {
		after: config.includeAfter === false ? undefined : options.after,
		limit: config.includeLimit === false ? undefined : options.limit,
	})

	if (options.scope && options.frame) {
		return { error: 'Cannot combine --scope and --frame. Use one or the other.' }
	}

	const derived = resolveDerivedNetFilters(options)
	if (derived.error) {
		return { error: derived.error }
	}

	const filters = appendNetFilterParams(params, {
		grep: options.grep,
		host: options.host,
		method: options.method,
		status: options.status,
		resourceType: options.resourceType,
		mime: options.mime,
		scope: options.scope,
		frame: options.frame,
		party: derived.party,
		failedOnly: options.failedOnly,
		minDurationMs: derived.minDurationMs,
		minTransferBytes: derived.minTransferBytes,
	})
	if (filters.error) {
		return filters
	}

	const ignore = appendNetIgnoreParams(params, options)
	if (ignore.error) {
		return ignore
	}

	return appendSinceParam(params, options.since)
}

export const parseSettleDurationMs = (value: string | undefined, fallback = '3s'): { value?: number; error?: string } => {
	const raw = value ?? fallback
	return parseNetDurationMs(raw, '--settle')
}

export const parseNetDurationMs = (value: string | undefined, flag: string): { value?: number; error?: string } => {
	if (value == null) {
		return {}
	}

	const parsed = parseDurationMs(value)
	if (parsed == null || parsed < 1) {
		return { error: `Invalid ${flag} value: ${value}` }
	}

	return { value: Math.round(parsed) }
}

const parseNetBytes = (value: string | undefined, flag: string): { value?: number; error?: string } => {
	if (value == null) {
		return {}
	}

	const trimmed = value.trim()
	const match = trimmed.match(/^([0-9]+(?:\.[0-9]+)?)(b|kb|mb|gb)?$/i)
	if (!match) {
		return { error: `Invalid ${flag} value: ${value}` }
	}

	const amount = Number(match[1])
	if (!Number.isFinite(amount) || amount < 0) {
		return { error: `Invalid ${flag} value: ${value}` }
	}

	const unit = (match[2] ?? 'b').toLowerCase()
	const multiplier = unit === 'b' ? 1 : unit === 'kb' ? 1024 : unit === 'mb' ? 1024 * 1024 : 1024 * 1024 * 1024
	return { value: Math.round(amount * multiplier) }
}

const resolvePartyFilter = (options: NetCliFilterOptions): { value?: 'first' | 'third'; error?: string } => {
	if (options.firstParty && options.thirdParty) {
		return { error: 'Cannot combine --first-party and --third-party.' }
	}

	if (options.firstParty) {
		return { value: 'first' }
	}

	if (options.thirdParty) {
		return { value: 'third' }
	}

	return {}
}

const resolveDerivedNetFilters = (
	options: NetCliFilterOptions,
): { party?: 'first' | 'third'; minDurationMs?: number; minTransferBytes?: number; error?: string } => {
	const party = resolvePartyFilter(options)
	if (party.error) {
		return { error: party.error }
	}

	const minDurationMs = parseNetDurationMs(options.slowOver, '--slow-over')
	if (minDurationMs.error) {
		return { error: minDurationMs.error }
	}

	const minTransferBytes = parseNetBytes(options.largeOver, '--large-over')
	if (minTransferBytes.error) {
		return { error: minTransferBytes.error }
	}

	return {
		party: party.value,
		minDurationMs: minDurationMs.value,
		minTransferBytes: minTransferBytes.value,
	}
}

/**
 * Drain every page of a `/net*` listing endpoint.
 *
 * `net export` and `net summary` both need the whole capture rather than one page, and both had
 * written the same cursor loop: copy the base params, set `after`/`limit`, stop on an empty page,
 * otherwise advance to `nextAfter`. The loop terminates because the watcher only ever returns
 * `nextAfter > after` while it has rows, and answers an empty page once the cursor passes the end.
 *
 * @param path Watcher path to page through, e.g. `/net` or `/net/requests`.
 * @param pageLimit Rows per request. The watcher clamps this to its own maximum.
 * @param select Pull the page out of the response; its `nextAfter` drives the cursor.
 */
export const fetchAllNetPages = async <TResponse extends { nextAfter: number }, TRow>(
	watcher: { host: string; port: number },
	options: NetCliFilterOptions,
	input: { path: string; pageLimit: number; select: (response: TResponse) => TRow[] },
): Promise<TRow[]> => {
	const baseParams = new URLSearchParams()
	const baseQuery = appendNetCommandParams(baseParams, options, { includeAfter: false, includeLimit: false })
	if (baseQuery.error) {
		throw new Error(baseQuery.error)
	}

	const rows: TRow[] = []
	let after = 0
	while (true) {
		const params = new URLSearchParams(baseParams)
		params.set('after', String(after))
		params.set('limit', String(input.pageLimit))

		const response = await fetchWatcherJson<TResponse>(watcher, { path: input.path, query: params, timeoutMs: 5_000 })
		const page = input.select(response)
		if (page.length === 0) {
			return rows
		}

		rows.push(...page)
		after = response.nextAfter
	}
}
