import { indexToColumnLetters } from './a1.js'

/** One physical header column and its normalized lookup metadata. */
export type SheetHeader = {
	index: number
	column: string
	a1: string
	original: string
	normalized: string
	empty: boolean
	duplicate: boolean
	duplicateIndex: number
	duplicateCount: number
}

/** Header-aware schema for a physical sheet row. */
export type SheetSchema = {
	headerRow: number
	headers: SheetHeader[]
	emptyColumns: string[]
	duplicateNames: Array<{ normalized: string; columns: string[]; originals: string[] }>
}

/** Normalize a header for deterministic lookup while preserving its original separately. */
export const normalizeHeaderName = (value: string): string =>
	value
		.normalize('NFKC')
		.replace(/[\s\u00a0]+/g, ' ')
		.trim()
		.toLocaleLowerCase()

/** Build duplicate/empty-aware schema metadata from one exact physical header row. */
export const buildSheetSchema = (values: readonly string[], headerRow: number): SheetSchema => {
	if (!Number.isInteger(headerRow) || headerRow < 1) throw new Error(`Header row must be a positive integer, got ${headerRow}.`)
	const normalized = values.map(normalizeHeaderName)
	const counts = new Map<string, number>()
	for (const name of normalized) if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
	const seen = new Map<string, number>()
	const headers = values.map((original, index): SheetHeader => {
		const name = normalized[index]
		const duplicateIndex = name ? (seen.get(name) ?? 0) + 1 : 0
		if (name) seen.set(name, duplicateIndex)
		const column = indexToColumnLetters(index)
		return {
			index: index + 1,
			column,
			a1: `${column}${headerRow}`,
			original,
			normalized: name,
			empty: name === '',
			duplicate: (counts.get(name) ?? 0) > 1,
			duplicateIndex,
			duplicateCount: name ? (counts.get(name) ?? 0) : 0,
		}
	})
	const duplicateNames = [...counts.entries()]
		.filter(([, count]) => count > 1)
		.map(([name]) => ({
			normalized: name,
			columns: headers.filter((header) => header.normalized === name).map((header) => header.column),
			originals: headers.filter((header) => header.normalized === name).map((header) => header.original),
		}))
	return { headerRow, headers, emptyColumns: headers.filter((header) => header.empty).map((header) => header.column), duplicateNames }
}

/** Resolve a non-empty, non-duplicate header by original, normalized, or A1 column name. */
export const resolveHeader = (schema: SheetSchema, value: string): SheetHeader | string => {
	const trimmed = value.trim()
	const byColumn = schema.headers.find((header) => header.column === trimmed.toUpperCase())
	if (byColumn) return byColumn.empty ? `Header column "${trimmed}" is empty.` : byColumn
	const byOriginal = schema.headers.filter((header) => header.original === trimmed)
	const normalized = normalizeHeaderName(trimmed)
	const candidates = byOriginal.length > 0 ? byOriginal : schema.headers.filter((header) => header.normalized === normalized)
	const resolved = candidates
	if (resolved.length === 0) return `Unknown header "${value}".`
	if (resolved.length > 1 || resolved[0].duplicate) return `Header "${value}" is duplicated; select an unambiguous column letter.`
	if (resolved[0].empty) return `Header "${value}" is empty.`
	return resolved[0]
}
