/**
 * How the mock server answers a `Range` header.
 *
 * - `ignore` — 200 with the whole body, what a plain static server does.
 * - `clamp` — RFC 7233: a suffix range longer than the file yields the whole file, else 206 + tail.
 * - `reject-oversized-suffix` — Express / `serve-static` / `range-parser`: a suffix longer than the
 *   file is "unsatisfiable" (416), not clamped. Anything shorter gets a normal 206.
 * - `reject-all` — a server that fails every ranged request without saying it was the range's fault
 *   (`send` surfaces this as a bare 500 on some versions).
 */
export type RangeBehavior = 'ignore' | 'clamp' | 'reject-oversized-suffix' | 'reject-all'

/** One request the mock served: the URL, plus the `Range` header it carried (`null` if unranged). */
export type RecordedRequest = { url: string; range: string | null }

/**
 * Replace `globalThis.fetch` with a lookup over an in-memory URL → body map.
 *
 * @param files - Absolute URL to response body. A missing URL answers 404.
 * @param options.ranges - How `Range` headers are honoured. Defaults to `ignore`.
 * @returns `restore` (call it in a `finally` so one test cannot leak into the next) and `requests`,
 * the requests served so far in order — enough to assert on cache hits, misses, and range use.
 */
export const mockStaticFetch = (
	files: Record<string, string>,
	options: { ranges?: RangeBehavior } = {},
): { restore: () => void; requests: RecordedRequest[] } => {
	const ranges = options.ranges ?? 'ignore'
	const previousFetch = globalThis.fetch
	const requests: RecordedRequest[] = []
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
		const range = readRangeHeader(init)
		requests.push({ url, range })

		const body = files[url]
		if (body === undefined) {
			return new Response('not found', { status: 404 })
		}

		return range === null ? new Response(body, { status: 200 }) : rangedResponse(body, range, ranges)
	}) as typeof fetch
	return {
		restore: () => {
			globalThis.fetch = previousFetch
		},
		requests,
	}
}

const readRangeHeader = (init: RequestInit | undefined): string | null => {
	const headers = init?.headers as Record<string, string> | undefined
	return headers?.Range ?? headers?.range ?? null
}

const rangedResponse = (body: string, range: string, behavior: RangeBehavior): Response => {
	if (behavior === 'ignore') {
		return new Response(body, { status: 200 })
	}
	if (behavior === 'reject-all') {
		return new Response('range failed', { status: 500 })
	}

	const bytes = Buffer.from(body, 'utf8')
	const suffix = readSuffixRange(range)
	if (suffix === null) {
		return new Response(body, { status: 200 })
	}

	if (suffix > bytes.length) {
		if (behavior === 'clamp') {
			return new Response(body, { status: 200 })
		}
		return new Response('range not satisfiable', { status: 416, headers: { 'Content-Range': `bytes */${bytes.length}` } })
	}

	const tail = bytes.subarray(bytes.length - suffix)
	const start = bytes.length - suffix
	return new Response(tail.toString('utf8'), {
		status: 206,
		headers: { 'Content-Range': `bytes ${start}-${bytes.length - 1}/${bytes.length}` },
	})
}

/** Parse `bytes=-N`, the only form the sourcemap resolver sends. Any other form reads as "no suffix". */
const readSuffixRange = (range: string): number | null => {
	const match = /^bytes=-(\d+)$/.exec(range.trim())
	return match ? Number(match[1]) : null
}

/** Build a `data:application/json;base64,…` sourcemap annotation payload. */
export const inlineSourcemap = (map: unknown): string =>
	`data:application/json;charset=utf-8;base64,${Buffer.from(JSON.stringify(map), 'utf8').toString('base64')}`

/** A minimal single-source map whose only mapping points at line 1, column 1 of `source`. */
export const identityMap = (source: string) => ({ version: 3, sources: [source], names: [], mappings: 'AAAA' })
