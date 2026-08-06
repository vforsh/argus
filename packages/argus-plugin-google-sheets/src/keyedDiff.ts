import type { LocatedRowCandidate } from './queryModel.js'
import type { SheetHeader } from './schema.js'

/** One keyed table row used by the diff engine. */
export type KeyedRow = {
	key: string
	values: Record<string, string>
	exportRow?: number
	sheetRow?: number
	a1?: string
}

/** Stable keyed table diff result. */
export type KeyedDiffResult = {
	additions: KeyedRow[]
	removals: KeyedRow[]
	changes: Array<{ key: string; before: KeyedRow; after: KeyedRow; columns: Array<{ column: string; before: string; after: string }> }>
	unchanged: number
}

/** Build keyed rows while rejecting missing and duplicate keys. */
export const buildKeyedRows = (
	rows: readonly (readonly string[])[],
	headers: readonly string[],
	keyColumn: string,
	columns: readonly string[],
	label: string,
): KeyedRow[] | string => {
	const keyIndex = headers.indexOf(keyColumn)
	if (keyIndex < 0) return `${label} is missing key column "${keyColumn}".`
	const columnIndexes = columns.map((column) => headers.indexOf(column))
	const missingColumn = columns.find((_, index) => columnIndexes[index] < 0)
	if (missingColumn) return `${label} is missing compared column "${missingColumn}".`
	const seen = new Map<string, number>()
	const result: KeyedRow[] = []
	for (let index = 0; index < rows.length; index++) {
		const key = rows[index][keyIndex] ?? ''
		if (!key) return `${label} row ${index + 2} has an empty key in "${keyColumn}".`
		const previous = seen.get(key)
		if (previous != null) return `${label} has duplicate key "${key}" at rows ${previous + 2} and ${index + 2}.`
		seen.set(key, index)
		const values: Record<string, string> = {}
		for (let column = 0; column < columns.length; column++) values[columns[column]] = rows[index][columnIndexes[column]] ?? ''
		result.push({ key, values })
	}
	return result
}

/** Diff two validated keyed tables in stable sheet/local source order. */
export const diffKeyedRows = (sheetRows: readonly KeyedRow[], localRows: readonly KeyedRow[], columns: readonly string[]): KeyedDiffResult => {
	const sheet = new Map(sheetRows.map((row) => [row.key, row]))
	const local = new Map(localRows.map((row) => [row.key, row]))
	const removals = sheetRows.filter((row) => !local.has(row.key))
	const additions = localRows.filter((row) => !sheet.has(row.key))
	const changes: KeyedDiffResult['changes'] = []
	let unchanged = 0
	for (const before of sheetRows) {
		const after = local.get(before.key)
		if (!after) continue
		const changedColumns = columns
			.filter((column) => before.values[column] !== after.values[column])
			.map((column) => ({ column, before: before.values[column] ?? '', after: after.values[column] ?? '' }))
		if (changedColumns.length === 0) unchanged++
		else changes.push({ key: before.key, before, after, columns: changedColumns })
	}
	return { additions, removals, changes, unchanged }
}

/** Convert located sheet candidates to keyed rows for diff coordinate output. */
export const candidatesToKeyedRows = (
	candidates: readonly (LocatedRowCandidate | { exportRow: number; values: string[] })[],
	keyHeader: SheetHeader,
	columns: readonly SheetHeader[],
): KeyedRow[] =>
	candidates.map((candidate) => {
		const values: Record<string, string> = {}
		for (const header of columns) values[header.original] = candidate.values[header.index - 1] ?? ''
		return {
			key: candidate.values[keyHeader.index - 1] ?? '',
			values,
			exportRow: candidate.exportRow,
			...('sheetRow' in candidate ? { sheetRow: candidate.sheetRow, a1: candidate.a1 } : {}),
		}
	})
