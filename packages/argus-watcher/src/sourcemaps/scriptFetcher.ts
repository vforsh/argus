/** A script body, plus whether the server answered with only the tail that was asked for. */
export type ScriptText = { text: string; partial: boolean }

/**
 * Fetch a script body. `tailBytes` asks for only the last N bytes; `null` asks for the whole file.
 * Resolves to `null` when the script cannot be read at all.
 */
export type ScriptFetcher = (scriptUrl: string, tailBytes: number | null) => Promise<ScriptText | null>

/**
 * Build a script fetcher that survives servers which reject suffix `Range` requests.
 *
 * The annotation lives on a bundle's last line, so a tail request is normally all we need. Servers
 * that ignore `Range` answer 200 with the whole body, which is fine. Servers built on
 * `range-parser` (Express, `serve-static`, `send` — the Cocos Creator preview server among them)
 * are not: for a file smaller than the requested tail they compute a negative start offset and
 * answer 416/500 instead of clamping to the whole representation as RFC 7233 asks. Every script
 * under `tailBytes` would otherwise resolve to `null` — sourcemaps silently off, one error in the
 * dev server's log per attempt, forever.
 *
 * So a failed ranged request is retried whole, and an origin caught doing this is remembered: the
 * remaining scripts from it are fetched unranged, costing that server exactly one logged error per
 * watcher instead of one per script per negative-cache expiry.
 */
export const createScriptFetcher = (): ScriptFetcher => {
	const rangeHostileOrigins = new Set<string>()

	return async (scriptUrl, tailBytes) => {
		const origin = originOf(scriptUrl)
		const ranged = tailBytes !== null && tailBytes > 0 && !rangeHostileOrigins.has(origin)
		const response = await fetch(scriptUrl, ranged ? { headers: { Range: `bytes=-${tailBytes}` } } : undefined)
		if (response.ok) {
			return readBody(response)
		}

		if (!ranged || !looksLikeRangeRejection(response.status)) {
			return null
		}

		await discardBody(response)
		const whole = await fetch(scriptUrl)
		if (!whole.ok) {
			// The script is unreadable either way, so the `Range` header is not what broke it.
			await discardBody(whole)
			return null
		}

		// Ranged failed where unranged succeeds: the header is the problem, whatever status was used
		// to report it (`send` surfaces the rejection as a 500 on some versions, not the RFC's 416).
		// The `has` re-check is for concurrent loads that all failed before any of them got here.
		if (!rangeHostileOrigins.has(origin)) {
			rangeHostileOrigins.add(origin)
			console.warn(`[Sourcemaps] ${origin} rejected a suffix Range request (HTTP ${response.status}); refetching scripts whole.`)
		}

		return readBody(whole)
	}
}

/**
 * Could a `Range` header have caused this status? 416 says so outright, and a server that throws
 * while parsing the range reports it as a 5xx. A 404 or a 403 is about the script, not the header,
 * so retrying it whole would just double the traffic for every script that is genuinely missing.
 */
const looksLikeRangeRejection = (status: number): boolean => status === 416 || status >= 500

const originOf = (scriptUrl: string): string => {
	try {
		return new URL(scriptUrl).origin
	} catch {
		return scriptUrl
	}
}

const readBody = async (response: Response): Promise<ScriptText> => ({ text: await response.text(), partial: response.status === 206 })

/** Release the connection an unread error body would otherwise hold open. */
const discardBody = async (response: Response): Promise<void> => {
	try {
		await response.body?.cancel()
	} catch {
		// Already consumed or closed; nothing to release.
	}
}
