/**
 * URL rewriting shared by every command that navigates or reloads a page.
 *
 * `page reload --param` (which drives Chrome directly over a target's WebSocket) and
 * `POST /navigate` (which runs inside the watcher) have to agree on what `--param foo=bar`
 * means, and on what `/settings` resolves to. Both once lived only in the CLI, so the
 * watcher had no way to reach them; keeping the rules here — in the dependency-free core —
 * is what lets the two paths stay identical.
 */

/** One parsed `key=value` pair, or the reason the input was rejected. */
export type ParamPairResult = { key: string; value: string } | { error: string }

/**
 * Parse a single `--param key=value` argument.
 *
 * The value may contain `=`; only the first one separates key from value. An empty key is
 * rejected rather than silently written as `""`.
 */
export const parseParamPair = (value: string): ParamPairResult => {
	const eqIdx = value.indexOf('=')
	if (eqIdx === -1) {
		return { error: `Invalid --param "${value}": missing "=".` }
	}
	const key = value.slice(0, eqIdx)
	if (key === '') {
		return { error: `Invalid --param "${value}": empty key.` }
	}
	return { key, value: value.slice(eqIdx + 1) }
}

/**
 * Parse a `--params "a=b&c=d"` argument into search params.
 *
 * Keys and values are percent-decoded, matching what a user would have typed into an
 * address bar. An empty string yields empty params rather than an error.
 */
export const parseParamsString = (value: string): URLSearchParams | { error: string } => {
	const params = new URLSearchParams()
	if (value.trim() === '') {
		return params
	}

	const pairs = value.split('&')
	for (const pair of pairs) {
		const eqIdx = pair.indexOf('=')
		if (eqIdx === -1) {
			return { error: `Invalid --params "${pair}": missing "=".` }
		}
		const key = pair.slice(0, eqIdx)
		if (key === '') {
			return { error: `Invalid --params "${pair}": empty key.` }
		}
		params.set(decodeURIComponent(key), decodeURIComponent(pair.slice(eqIdx + 1)))
	}
	return params
}

/** True when the URL uses a scheme whose query string Argus is willing to rewrite. */
export const isHttpUrl = (url: string): boolean => url.startsWith('http://') || url.startsWith('https://')

/** Query overrides accepted by {@link applyQueryParams}. Both are optional and compose. */
export type QueryParamOverrides = {
	/** Repeatable `key=value` pairs, applied last so an explicit flag wins. */
	param?: readonly string[]
	/** A single `a=b&c=d` string. */
	params?: string
}

/**
 * Rewrite a URL's query string with overwrite semantics.
 *
 * Existing params the caller did not mention are preserved; ones it did are replaced, never
 * appended. `params` is applied before `param` so a repeated `--param` flag wins over the
 * bulk string when both name the same key.
 *
 * @param baseUrl Absolute http/https URL to rewrite.
 * @param overrides Query overrides. When neither is present, `baseUrl` is returned unchanged.
 * @returns The rewritten URL, or the reason the rewrite was refused (non-http scheme,
 *   unparseable URL, malformed pair).
 */
export const applyQueryParams = (baseUrl: string, overrides: QueryParamOverrides): { url: string } | { error: string } => {
	const hasParam = (overrides.param?.length ?? 0) > 0
	const hasParams = overrides.params != null
	if (!hasParam && !hasParams) {
		return { url: baseUrl }
	}

	if (!isHttpUrl(baseUrl)) {
		return { error: `URL "${baseUrl}" is not http/https. Cannot update query params.` }
	}

	let parsed: URL
	try {
		parsed = new URL(baseUrl)
	} catch {
		return { error: `Invalid URL "${baseUrl}".` }
	}

	if (hasParams) {
		const fromString = parseParamsString(overrides.params!)
		if ('error' in fromString) {
			return fromString
		}
		for (const [key, value] of fromString.entries()) {
			parsed.searchParams.set(key, value)
		}
	}

	for (const pair of overrides.param ?? []) {
		const parsedPair = parseParamPair(pair)
		if ('error' in parsedPair) {
			return parsedPair
		}
		parsed.searchParams.set(parsedPair.key, parsedPair.value)
	}

	return { url: parsed.toString() }
}

/** A scheme followed by `//`, or any other scheme (`about:`, `data:`, `mailto:`). */
const SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
/** `host:port` — the one shape that also matches {@link SCHEME_PATTERN} but is not a scheme. */
const HOST_PORT_PATTERN = /^[^/?#:]+:\d+(?:[/?#]|$)/
/** Leading forms that are unambiguously relative to the current document. */
const RELATIVE_PATTERN = /^[/?#]|^\.\.?(?:[/?#]|$)/

/**
 * Resolve what the user typed into an absolute URL to navigate to.
 *
 * Three shapes reach this, and only one of them is a URL already:
 * - relative — anything starting with `/`, `?`, `#`, `./` or `../` is resolved against
 *   `currentUrl`. This is why resolution runs in the watcher: it owns the authoritative URL.
 * - absolute (`https://x/y`, `about:blank`) — used verbatim.
 * - scheme-less (`localhost:3000`, `example.com/x`) — gets `http://`, matching what a browser
 *   address bar does.
 *
 * The leading character decides, deliberately: a bare token like `settings` becomes
 * `http://settings/` rather than being guessed at, so `argus goto app /settings` and
 * `argus goto app settings` never silently mean the same thing.
 *
 * @param input What the user typed. Whitespace is trimmed.
 * @param currentUrl The page's current top-frame URL, or `null` when nothing is attached.
 * @returns The absolute URL, or the reason it could not be resolved.
 */
export const resolveNavigationUrl = (input: string, currentUrl: string | null): { url: string } | { error: string } => {
	const trimmed = input.trim()
	if (trimmed === '') {
		return { error: 'URL must be a non-empty string.' }
	}

	if (RELATIVE_PATTERN.test(trimmed)) {
		if (!currentUrl) {
			return { error: `Cannot resolve relative URL "${trimmed}": the page has no current URL.` }
		}
		try {
			return { url: new URL(trimmed, currentUrl).toString() }
		} catch {
			return { error: `Cannot resolve "${trimmed}" against "${currentUrl}".` }
		}
	}

	// `localhost:3000` also matches SCHEME_PATTERN, so the host:port shape is checked first.
	if (HOST_PORT_PATTERN.test(trimmed) || !SCHEME_PATTERN.test(trimmed)) {
		return { url: `http://${trimmed}` }
	}

	return { url: trimmed }
}
