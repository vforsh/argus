import { originalPositionFor } from '@jridgewell/trace-mapping'
import type { TraceMap } from '@jridgewell/trace-mapping'

/** A location as Chrome reported it: bundle URL plus 1-based line/column. */
export type GeneratedLocation = {
	file: string | null
	line: number | null
	column: number | null
}

/** A location mapped back to original sources. Line/column stay 1-based. */
export type ResolvedLocation = {
	file: string
	line: number
	column: number
}

/**
 * Map a generated location through an already-loaded sourcemap.
 *
 * Pure: fetching and caching live in `createSourcemapResolver` (`./sourcemapResolver.js`).
 * `trace-mapping` is 0-based on columns and 1-based on lines, so columns are shifted on the way in
 * and back out.
 *
 * @returns The original location, or `null` when the map has no entry for it.
 */
export const resolveSourcemappedLocationWithMap = (traceMap: TraceMap, location: { line: number; column: number }): ResolvedLocation | null => {
	if (location.line <= 0 || location.column <= 0) {
		return null
	}

	const position = originalPositionFor(traceMap, {
		line: location.line,
		column: Math.max(location.column - 1, 0),
	})

	if (!position.source || position.line == null || position.column == null) {
		return null
	}

	return {
		file: position.source,
		line: position.line,
		column: position.column + 1,
	}
}
