import { TraceMap } from '@jridgewell/trace-mapping'
import type { SourceMapInput } from '@jridgewell/trace-mapping'
import { readSourcemapReference } from './sourceMappingUrl.js'
import { createScriptFetcher, type ScriptFetcher } from './scriptFetcher.js'
import { resolveSourcemappedLocationWithMap, type GeneratedLocation, type ResolvedLocation } from './resolveLocation.js'

/**
 * Per-watcher sourcemap lookup.
 *
 * One instance is owned by the watcher runtime rather than the module, so the cache dies with the
 * watcher and a navigation can reset it — a stale or failed map never outlives the page that
 * produced it.
 */
export type SourcemapResolver = {
	/** Map a generated location back to its original source, or `null` when no map applies. */
	resolve: (location: GeneratedLocation, signal?: AbortSignal) => Promise<ResolvedLocation | null>
	/** Drop every cached map. Called on top-level navigation so a rebuilt bundle is re-read. */
	clear: () => void
}

export type SourcemapResolverOptions = {
	/** Hard cap on cached scripts. Oldest entries are evicted first. Default 128. */
	maxEntries?: number
	/** Total script + map load deadline, including response bodies. Default 2s. */
	loadTimeoutMs?: number
	/** How long a "no usable map" answer is trusted before being retried. Default 30s. */
	negativeTtlMs?: number
	/**
	 * Bytes requested from the end of a script when hunting for the annotation. Default 64 KiB.
	 * A server that rejects the resulting suffix `Range` is retried whole — see `createScriptFetcher`.
	 */
	tailBytes?: number
}

const DEFAULT_MAX_ENTRIES = 128
const DEFAULT_NEGATIVE_TTL_MS = 30_000
const DEFAULT_TAIL_BYTES = 64 * 1024

type CacheEntry = {
	traceMap: TraceMap | null
	/** `Infinity` for hits: a map that loaded stays until eviction or `clear()`. */
	expiresAt: number
}

/**
 * Build a sourcemap resolver.
 *
 * Map locations come from each bundle's own `//# sourceMappingURL=` annotation, never from a
 * `<script>.map` guess, so query strings, CDN-hosted maps, and inline `data:` maps all work.
 */
export const createSourcemapResolver = (options: SourcemapResolverOptions = {}): SourcemapResolver => {
	const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
	const negativeTtlMs = options.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS
	const tailBytes = options.tailBytes ?? DEFAULT_TAIL_BYTES

	/** Owned per resolver so a range-hostile origin is learned once and remembered across scripts. */
	const fetchScript = createScriptFetcher()

	const cache = new Map<string, CacheEntry>()
	const pending = new Map<string, { promise: Promise<TraceMap | null>; controller: AbortController }>()
	/** Bumped by `clear()`; in-flight loads started before the bump don't get to populate the cache. */
	let generation = 0

	const clear = (): void => {
		generation += 1
		for (const load of pending.values()) load.controller.abort()
		cache.clear()
		pending.clear()
	}

	const readCache = (scriptUrl: string): CacheEntry | null => {
		const entry = cache.get(scriptUrl)
		if (!entry) {
			return null
		}
		if (entry.expiresAt <= Date.now()) {
			cache.delete(scriptUrl)
			return null
		}
		// Re-insert so iteration order stays least-recently-used first.
		cache.delete(scriptUrl)
		cache.set(scriptUrl, entry)
		return entry
	}

	const writeCache = (scriptUrl: string, traceMap: TraceMap | null): void => {
		cache.set(scriptUrl, { traceMap, expiresAt: traceMap ? Infinity : Date.now() + negativeTtlMs })
		while (cache.size > maxEntries) {
			const oldest = cache.keys().next()
			if (oldest.done) {
				break
			}
			cache.delete(oldest.value)
		}
	}

	const getTraceMap = (scriptUrl: string): Promise<TraceMap | null> => {
		const cached = readCache(scriptUrl)
		if (cached) {
			return Promise.resolve(cached.traceMap)
		}

		const inFlight = pending.get(scriptUrl)
		if (inFlight) {
			return inFlight.promise
		}

		// Concurrent log bursts must not create an unbounded set of stalled HTTP loads.
		if (pending.size >= Math.max(1, maxEntries)) return Promise.resolve(null)
		const startedAt = generation
		const controller = new AbortController()
		const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(options.loadTimeoutMs ?? 2_000)])
		const promise = loadTraceMap(scriptUrl, tailBytes, fetchScript, signal)
			.catch(() => null)
			.then((traceMap) => {
				if (startedAt === generation) {
					writeCache(scriptUrl, traceMap)
				}
				return traceMap
			})
			.finally(() => {
				if (pending.get(scriptUrl)?.promise === promise) pending.delete(scriptUrl)
			})

		pending.set(scriptUrl, { promise, controller })
		return promise
	}

	const resolve = async (location: GeneratedLocation, signal?: AbortSignal): Promise<ResolvedLocation | null> => {
		if (!location.file || location.line == null || location.column == null) {
			return null
		}

		const scriptUrl = normalizeHttpUrl(location.file)
		if (!scriptUrl) {
			return null
		}

		signal?.throwIfAborted()
		// Keep the worker until the shared physical load settles. Cancelling individual waiters
		// must not free slots for an unlimited stream of new loads during a logging burst.
		const traceMap = await getTraceMap(scriptUrl)
		signal?.throwIfAborted()
		if (!traceMap) {
			return null
		}

		return resolveSourcemappedLocationWithMap(traceMap, { line: location.line, column: location.column })
	}

	return { resolve, clear }
}

const loadTraceMap = async (scriptUrl: string, tailBytes: number, fetchScript: ScriptFetcher, signal: AbortSignal): Promise<TraceMap | null> => {
	const tail = await fetchScript(scriptUrl, tailBytes, signal)
	if (!tail) {
		return null
	}

	let reference = readSourcemapReference(tail.text, scriptUrl)
	if (!reference && tail.partial) {
		// An inline `data:` map is longer than the tail window, so its annotation starts above it.
		const full = await fetchScript(scriptUrl, null, signal)
		reference = full ? readSourcemapReference(full.text, scriptUrl) : null
	}

	if (!reference) {
		return null
	}

	if (reference.kind === 'inline') {
		return new TraceMap(reference.map, reference.baseUrl)
	}

	const rawMap = await fetchSourcemap(reference.url, signal)
	if (!rawMap) {
		return null
	}

	// Base against the map URL, not the script: `sources` are relative to wherever the map lives.
	return new TraceMap(rawMap, reference.url)
}

/** Fetch and parse a sourcemap. A server answering 200-with-JavaScript fails the parse and yields null. */
const fetchSourcemap = async (mapUrl: string, signal: AbortSignal): Promise<SourceMapInput | null> => {
	const response = await fetch(mapUrl, { signal })
	if (!response.ok) {
		await response.body?.cancel().catch(() => {})
		return null
	}

	try {
		return JSON.parse(await response.text()) as SourceMapInput
	} catch {
		return null
	}
}

const normalizeHttpUrl = (value: string): string | null => {
	let url: URL
	try {
		url = new URL(value)
	} catch {
		return null
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return null
	}

	return url.toString()
}
