/** Expand an A1 range for a matrix shape inside serialized browser code. */
export function expandA1RangeForShape(range: string, rowCount: number, columnCount: number): string {
	const [start] = splitA1Range(range)
	const cell = parseA1Cell(start)
	if (!cell || rowCount <= 0 || columnCount <= 0) return range
	const endColumn = indexToColumnLetters(cell.column + columnCount - 1)
	const endRow = cell.row + rowCount
	const sheetPrefix = cell.sheet ? `${cell.sheet}!` : ''
	return rowCount === 1 && columnCount === 1
		? `${sheetPrefix}${start.replace(/^.*!/, '')}`
		: `${sheetPrefix}${cell.columnLetters}${cell.row + 1}:${endColumn}${endRow}`
}

/** Split an A1 range inside serialized browser code. */
export function splitA1Range(range: string): [string, string | undefined] {
	const bangIndex = range.lastIndexOf('!')
	const colonIndex = range.indexOf(':', bangIndex + 1)
	return colonIndex >= 0 ? [range.slice(0, colonIndex), range.slice(colonIndex + 1)] : [range, undefined]
}

/** Parse one A1 cell inside serialized browser code. */
export function parseA1Cell(value: string): { sheet: string | null; columnLetters: string; column: number; row: number } | null {
	const bangIndex = value.lastIndexOf('!')
	const sheet = bangIndex >= 0 ? value.slice(0, bangIndex) : null
	const cell = (bangIndex >= 0 ? value.slice(bangIndex + 1) : value).replace(/\$/g, '').trim()
	const match = cell.match(/^([A-Za-z]+)(\d+)$/)
	if (!match) return null
	const columnLetters = match[1].toUpperCase()
	return { sheet, columnLetters, column: columnLettersToIndex(columnLetters), row: Number(match[2]) - 1 }
}

/** Convert A1 letters to a zero-based index inside serialized browser code. */
export function columnLettersToIndex(letters: string): number {
	let index = 0
	for (const character of letters.toUpperCase()) index = index * 26 + character.charCodeAt(0) - 64
	return index - 1
}

/** Convert a zero-based index to A1 letters inside serialized browser code. */
export function indexToColumnLetters(index: number): string {
	let value = index + 1
	let letters = ''
	while (value > 0) {
		const remainder = (value - 1) % 26
		letters = String.fromCharCode(65 + remainder) + letters
		value = Math.floor((value - 1) / 26)
	}
	return letters
}
