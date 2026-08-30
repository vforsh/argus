/**
 * Replace `globalThis.fetch` with a lookup over an in-memory URL → body map.
 *
 * Bodies are served whole (status 200) even for `Range` requests, which is what a plain static
 * server does and what the sourcemap resolver's non-partial path expects.
 *
 * @param files - Absolute URL to response body. A missing URL answers 404.
 * @returns `restore` (call it in a `finally` so one test cannot leak into the next) and `requests`,
 * the URLs requested so far in order — enough to assert on cache hits and misses.
 */
export const mockStaticFetch = (files: Record<string, string>): { restore: () => void; requests: string[] } => {
	const previousFetch = globalThis.fetch
	const requests: string[] = []
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
		requests.push(url)
		const body = files[url]
		if (body === undefined) {
			return new Response('not found', { status: 404 })
		}
		return new Response(body, { status: 200 })
	}) as typeof fetch
	return {
		restore: () => {
			globalThis.fetch = previousFetch
		},
		requests,
	}
}

/** Build a `data:application/json;base64,…` sourcemap annotation payload. */
export const inlineSourcemap = (map: unknown): string =>
	`data:application/json;charset=utf-8;base64,${Buffer.from(JSON.stringify(map), 'utf8').toString('base64')}`

/** A minimal single-source map whose only mapping points at line 1, column 1 of `source`. */
export const identityMap = (source: string) => ({ version: 3, sources: [source], names: [], mappings: 'AAAA' })
