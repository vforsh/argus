import { columnLettersToIndex } from './a1.js'

/** Coordinate-free match from a possibly collapsed whole-sheet export. */
export type ExportCellMatch = { exportRow: number; exportColumn: number; value: string }

/** Resolve a find column by exact header first, then number or absolute A1 letters. */
export const resolveFindColumn = (column: string | undefined, headers: readonly string[]): number | null | false => {
	if (!column) return null
	const headerIndex = headers.findIndex((header) => header === column)
	if (headerIndex >= 0) return headerIndex
	const asNumber = Number(column)
	if (Number.isInteger(asNumber) && asNumber > 0) return asNumber - 1
	if (/^[A-Za-z]+$/.test(column)) return columnLettersToIndex(column)
	return false
}

/** Search export candidates without ever assigning a physical row/A1. */
export const findExportMatches = (
	rows: string[][],
	needle: string,
	options: { columnIndex: number | null; ignoreCase: boolean; limit: number },
): ExportCellMatch[] => {
	const matches: ExportCellMatch[] = []
	for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
		const row = rows[rowIndex]
		const start = options.columnIndex ?? 0
		const end = options.columnIndex ?? row.length - 1
		for (let columnIndex = start; columnIndex <= end; columnIndex++) {
			const value = row[columnIndex] ?? ''
			const haystack = options.ignoreCase ? value.toLocaleLowerCase() : value
			if (!haystack.includes(needle)) continue
			matches.push({ exportRow: rowIndex + 1, exportColumn: columnIndex + 1, value })
			if (matches.length >= options.limit) return matches
		}
	}
	return matches
}
