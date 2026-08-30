/**
 * Typed shapes for the GET half of the protocol.
 *
 * Every POST body and every response has a type here; the query string did not, so it lived as
 * untyped `params.set('…')` calls in three independent places — the CLI's builder, the client
 * SDK's builder, and the watcher's parsers. They had already drifted: the CLI could express
 * eleven network filters and the SDK three, so the SDK could not ask for filters the protocol
 * supports. These types are the contract all three now conform to.
 */

/** Whether `match` patterns are applied case-sensitively. */
export type MatchCase = 'sensitive' | 'insensitive'

/** Which part of the page a network query covers. */
export const NET_SCOPES = ['selected', 'page', 'tab'] as const

/** Which part of the page a network query covers. */
export type NetScope = (typeof NET_SCOPES)[number]

/** First-party vs third-party request classification. */
export const NET_PARTIES = ['first', 'third'] as const

/** First-party vs third-party request classification. */
export type NetParty = (typeof NET_PARTIES)[number]

/** Query parameters accepted by the log listing and tail routes. */
export type LogsQuery = {
	/** Opaque epoch cursor; mutually exclusive with `sinceEpoch`. */
	after?: string
	/** Opaque watcher-session marker to read forward from. */
	sinceEpoch?: string
	limit?: number
	/** Comma-separated log levels. */
	levels?: string
	/** Regex patterns, repeatable. */
	match?: string[]
	matchCase?: MatchCase
	/** Substring filter over the event source. */
	source?: string
	/** Epoch milliseconds; events older than this are dropped. */
	sinceTs?: number
	/** Long-poll budget, tail routes only. */
	timeoutMs?: number
}

/** Query parameters accepted by the network listing routes. */
export type NetQuery = {
	/** Numeric record cursor. */
	after?: number
	limit?: number
	/** Epoch milliseconds; requests older than this are dropped. */
	sinceTs?: number
	/** Substring match over redacted URLs. */
	grep?: string
	/** Keep only these hosts (exact host or subdomain). */
	host?: string[]
	/** Keep only these HTTP methods. */
	method?: string[]
	/** Keep only these statuses; `4xx`-style patterns are accepted. */
	status?: string[]
	/** Keep only these CDP resource types. */
	resourceType?: string[]
	/** Keep only these response MIME types. */
	mime?: string[]
	/** Defaults to `tab`. Mutually exclusive with `frame`. */
	scope?: NetScope
	/** A frame id, or `selected`/`page`. Mutually exclusive with `scope`. */
	frame?: string
	party?: NetParty
	/** Keep only failed requests. */
	failedOnly?: boolean
	minDurationMs?: number
	minTransferBytes?: number
	/** Drop requests to these hosts. */
	ignoreHost?: string[]
	/** Drop requests whose URL contains one of these substrings. */
	ignorePattern?: string[]
	/** Long-poll budget, tail routes only. */
	timeoutMs?: number
}

/** A value a query parameter can carry before serialization. */
export type QueryValue = string | number | boolean | readonly string[] | null | undefined

/**
 * Serialize a typed query object into `URLSearchParams`.
 *
 * Omits `undefined`, `null`, `false`, blank strings, and empty arrays, so callers can hand over
 * a partially populated object without guarding each field. `true` becomes `'1'` to match the
 * watcher's truthy-flag reader. Values are trimmed; validation stays with the caller, which owns
 * the error message its users should see.
 */
export const toSearchParams = (query: Record<string, QueryValue>): URLSearchParams => {
	const params = new URLSearchParams()

	for (const [key, value] of Object.entries(query)) {
		appendQueryValue(params, key, value)
	}

	return params
}

const appendQueryValue = (params: URLSearchParams, key: string, value: QueryValue): void => {
	if (value == null || value === false) {
		return
	}

	if (value === true) {
		params.set(key, '1')
		return
	}

	if (typeof value === 'number') {
		params.set(key, String(value))
		return
	}

	if (typeof value === 'string') {
		const trimmed = value.trim()
		if (trimmed) {
			params.set(key, trimmed)
		}
		return
	}

	for (const entry of value) {
		const trimmed = entry.trim()
		if (trimmed) {
			params.append(key, trimmed)
		}
	}
}

/** Trim a query value, treating blank as absent. */
export const normalizeQueryValue = (value: string | null | undefined): string | undefined => {
	if (value == null) {
		return undefined
	}

	const trimmed = value.trim()
	return trimmed ? trimmed : undefined
}

/**
 * Trim repeatable match patterns, rejecting blanks.
 *
 * A blank pattern would match everything, so it is far more likely to be a shell-quoting mistake
 * than an intent — both the CLI and the SDK surface it as an error rather than silently dropping it.
 */
export const normalizeMatchPatterns = (match?: readonly string[]): { patterns: string[]; error?: string } => {
	if (!match || match.length === 0) {
		return { patterns: [] }
	}

	const patterns = match.map((value) => value.trim())
	if (patterns.some((value) => value.length === 0)) {
		return { patterns: [], error: 'Invalid match value: empty pattern.' }
	}

	return { patterns }
}
