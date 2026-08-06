/** Parsed zero-based A1 cell coordinates. */
export type A1Cell = {
	sheet: string | null
	column: number
	row: number
}

/** Parsed inclusive A1 rectangle coordinates. */
export type A1Bounds = {
	sheet: string | null
	startColumn: number
	startRow: number
	endColumn: number
	endRow: number
}

/** Convert a zero-based column index to A1 letters. */
export const indexToColumnLetters = (index: number): string => {
	if (!Number.isInteger(index) || index < 0) throw new Error(`Column index must be a non-negative integer, got ${index}.`)
	let value = index + 1
	let letters = ''
	while (value > 0) {
		const remainder = (value - 1) % 26
		letters = String.fromCharCode(65 + remainder) + letters
		value = Math.floor((value - 1) / 26)
	}
	return letters
}

/** Convert A1 column letters to a zero-based index. */
export const columnLettersToIndex = (letters: string): number => {
	if (!/^[A-Za-z]+$/.test(letters)) throw new Error(`Invalid A1 column letters: ${letters}.`)
	let value = 0
	for (const character of letters.toUpperCase()) value = value * 26 + character.charCodeAt(0) - 64
	return value - 1
}

/** Parse one A1 cell, including an optional quoted sheet qualifier. */
export const parseA1Cell = (value: string): A1Cell | null => {
	const trimmed = value.trim()
	const bangIndex = findQualifierBang(trimmed)
	const rawSheet = bangIndex >= 0 ? trimmed.slice(0, bangIndex) : null
	const cell = (bangIndex >= 0 ? trimmed.slice(bangIndex + 1) : trimmed).replace(/\$/g, '')
	const match = cell.match(/^([A-Za-z]+)([1-9]\d*)$/)
	if (!match) return null
	return {
		sheet: rawSheet == null ? null : unquoteSheetName(rawSheet),
		column: columnLettersToIndex(match[1]),
		row: Number(match[2]) - 1,
	}
}

/** Parse an inclusive A1 cell range. Reversed endpoints are normalized. */
export const parseA1Range = (value: string): A1Bounds | null => {
	const [startValue, endValue] = splitA1Range(value)
	const start = parseA1Cell(startValue)
	if (!start) return null
	const end = endValue ? parseA1Cell(`${start.sheet ? `${quoteSheetName(start.sheet)}!` : ''}${stripSheetQualifier(endValue)}`) : start
	if (!end || end.sheet !== start.sheet) return null
	return {
		sheet: start.sheet,
		startColumn: Math.min(start.column, end.column),
		startRow: Math.min(start.row, end.row),
		endColumn: Math.max(start.column, end.column),
		endRow: Math.max(start.row, end.row),
	}
}

/** Split an A1 range on the colon outside a quoted sheet name. */
export const splitA1Range = (value: string): [string, string | undefined] => {
	let quoted = false
	for (let index = 0; index < value.length; index++) {
		const character = value[index]
		if (character === "'" && value[index + 1] === "'") {
			index++
			continue
		}
		if (character === "'") quoted = !quoted
		if (character === ':' && !quoted) return [value.slice(0, index), value.slice(index + 1)]
	}
	return [value, undefined]
}

/** Format zero-based coordinates as an A1 cell. */
export const formatA1Cell = (column: number, row: number, sheet?: string | null): string => {
	if (!Number.isInteger(row) || row < 0) throw new Error(`Row index must be a non-negative integer, got ${row}.`)
	const prefix = sheet ? `${quoteSheetName(sheet)}!` : ''
	return `${prefix}${indexToColumnLetters(column)}${row + 1}`
}

/** Return an A1 cell offset from the top-left cell of a range. */
export const a1ForOffset = (range: string, rowOffset: number, columnOffset: number): string => {
	const bounds = parseA1Range(range)
	if (!bounds) throw new Error(`Invalid A1 range: ${range}.`)
	return formatA1Cell(bounds.startColumn + columnOffset, bounds.startRow + rowOffset, bounds.sheet)
}

/** Expand a top-left A1 cell/range to a rectangular shape. */
export const expandA1RangeForShape = (range: string, rowCount: number, columnCount: number): string => {
	const bounds = parseA1Range(range)
	if (!bounds || !Number.isInteger(rowCount) || rowCount < 1 || !Number.isInteger(columnCount) || columnCount < 1) {
		throw new Error(`Cannot expand invalid A1 range/shape: ${range}, ${rowCount}x${columnCount}.`)
	}
	const start = formatA1Cell(bounds.startColumn, bounds.startRow, bounds.sheet)
	if (rowCount === 1 && columnCount === 1) return start
	const end = formatA1Cell(bounds.startColumn + columnCount - 1, bounds.startRow + rowCount - 1)
	return `${start}:${end}`
}

/** Build an exact physical row range for a known first/last column. */
export const exactRowRange = (row: number, startColumn: number, endColumn: number): string => {
	if (!Number.isInteger(row) || row < 1) throw new Error(`Physical row must be a positive integer, got ${row}.`)
	return `${indexToColumnLetters(startColumn)}${row}:${indexToColumnLetters(endColumn)}${row}`
}

/** Quote a sheet name when A1 syntax requires it. */
export const quoteSheetName = (sheet: string): string => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(sheet) ? sheet : `'${sheet.replace(/'/g, "''")}'`)

const stripSheetQualifier = (value: string): string => {
	const bang = findQualifierBang(value)
	return bang >= 0 ? value.slice(bang + 1) : value
}

const findQualifierBang = (value: string): number => {
	let quoted = false
	for (let index = 0; index < value.length; index++) {
		if (value[index] === "'" && value[index + 1] === "'") {
			index++
			continue
		}
		if (value[index] === "'") quoted = !quoted
		if (value[index] === '!' && !quoted) return index
	}
	return -1
}

const unquoteSheetName = (value: string): string => {
	const trimmed = value.trim()
	return trimmed.startsWith("'") && trimmed.endsWith("'") ? trimmed.slice(1, -1).replace(/''/g, "'") : trimmed
}
