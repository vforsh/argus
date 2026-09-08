/**
 * Pure model behind the exact-row locator, serialized into the page alongside the locator itself.
 *
 * The whole-sheet gviz export only ever *drops* rows (blank ones), never reorders or inserts them.
 * So for every candidate `physicalRow >= exportRow`, and the offset `physicalRow - exportRow` never
 * decreases as you walk down the sheet. Carrying that offset forward turns "scan the sheet from the
 * header until something matches" into "probe the one row the offset predicts", which is why a
 * locate now costs roughly one fetch per candidate plus one per blank row in between.
 *
 * Every export here is a function declaration so `buildLocatorExpression` can serialize it by name.
 */

/**
 * Rows to fetch next while locating one candidate, in probe order.
 *
 * The first probe is the single row the offset predicts, and each later probe fetches as many rows as
 * the candidate has already cost, capped at `batchSize` — 1, 1, 2, 4, 8, … So a correct prediction
 * costs one fetch, a one-row drift costs two, and a long run of dropped rows is crossed in a handful
 * of parallel batches instead of a row at a time.
 *
 * @param input `probed` is how many rows this candidate already cost; `minRow` keeps the walk inside
 * the data area and past the previously located row, so two candidates can never claim one row.
 * @returns An empty array when the next probe would pass `maxRow` — the candidate is unreachable and
 * the locator must report `incomplete` rather than invent a coordinate.
 */
export function planLocatorProbes(input: {
	exportRow: number
	offset: number
	probed: number
	minRow: number
	maxRow: number
	batchSize: number
}): number[] {
	const first = Math.max(input.minRow, input.exportRow + input.offset) + input.probed
	if (first > input.maxRow) return []
	const width = Math.min(input.batchSize, Math.max(1, input.probed), input.maxRow - first + 1)
	return Array.from({ length: width }, (_, index) => first + index)
}

/** Offset implied by a located candidate. Monotone: a match never moves the offset backwards. */
export function advanceLocator(offset: number, exportRow: number, sheetRow: number): number {
	return Math.max(offset, sheetRow - exportRow)
}

/**
 * Backoff before retrying a throttled or failed gviz row fetch.
 *
 * @returns The delay for a zero-based attempt, or `null` once the three retries are spent — the
 * caller then throws, because a locator that silently skips a row would fabricate a coordinate.
 */
export function retryDelaysMs(attempt: number): number | null {
	const delays = [250, 500, 1_000]
	return attempt >= 0 && attempt < delays.length ? delays[attempt] : null
}
