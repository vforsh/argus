import { indexToColumnLetters } from './pageA1.js'
import { getSpreadsheetId, parseCsvInPage } from './sheetDataPageScripts.js'

/** Exact physical cell match found through a single-row authenticated read. */
export type ExactCellMatch = {
	sheetRow: number
	column: number
	a1: string
	value: string
	exactVerified: true
}

/** Exact physical query row matched to one whole-export candidate. */
export type ExactRowMatch = {
	exportRow: number
	values: string[]
	sheetRow: number
	a1: string
	exactVerified: true
}

/** Bounded exact locator result; incomplete scans never invent coordinates. */
export type ExactLocatorResult<T> = {
	ok: true
	matches: T[]
	scannedRows: number
	complete: boolean
	reason: 'found' | 'max-row' | 'deadline'
}

/** Build a bounded exact-row locator for corrected `find`. */
export const buildLocateCellsExpression = (input: {
	gid: string
	startRow: number
	maxRow: number
	firstColumn?: number
	lastColumn: number
	needle: string
	columnIndex: number | null
	ignoreCase: boolean
	limit: number
	expectedMatches: number
	deadlineMs: number
	batchSize?: number
}): string => buildLocatorExpression(locateCellsInPage, input)

/** Build a bounded exact-row locator for query/diff candidates. */
export const buildLocateRowsExpression = (input: {
	gid: string
	startRow: number
	maxRow: number
	width: number
	candidates: Array<{ exportRow: number; values: string[] }>
	deadlineMs: number
	batchSize?: number
}): string => buildLocatorExpression(locateRowsInPage, input)

const locatorHelpers = [getSpreadsheetId, parseCsvInPage, indexToColumnLetters, fetchExactRowInPage, exactRowsEqual]
const buildLocatorExpression = <T>(fn: (input: T) => unknown, input: T): string => `(() => {
${locatorHelpers.map((helper) => helper.toString()).join('\n')}
return (${fn.toString()})(${JSON.stringify(input)})
})()`

async function locateCellsInPage(input: {
	gid: string
	startRow: number
	maxRow: number
	firstColumn?: number
	lastColumn: number
	needle: string
	columnIndex: number | null
	ignoreCase: boolean
	limit: number
	expectedMatches: number
	deadlineMs: number
	batchSize?: number
}): Promise<ExactLocatorResult<ExactCellMatch>> {
	const spreadsheetId = getSpreadsheetId()
	const deadlineAt = Date.now() + input.deadlineMs
	const batchSize = Math.min(25, Math.max(1, input.batchSize ?? 10))
	const matches: ExactCellMatch[] = []
	let scannedRows = 0
	for (let firstRow = input.startRow; firstRow <= input.maxRow; firstRow += batchSize) {
		if (Date.now() >= deadlineAt) return { ok: true, matches, scannedRows, complete: false, reason: 'deadline' }
		const rowNumbers = Array.from({ length: Math.min(batchSize, input.maxRow - firstRow + 1) }, (_, index) => firstRow + index)
		const exactRows = await Promise.all(rowNumbers.map((row) => fetchExactRowInPage(spreadsheetId, input.gid, row, input.lastColumn)))
		for (let offset = 0; offset < exactRows.length; offset++) {
			const row = exactRows[offset]
			const sheetRow = rowNumbers[offset]
			const start = input.columnIndex ?? input.firstColumn ?? 0
			const end = input.columnIndex ?? input.lastColumn
			for (let column = start; column <= end; column++) {
				const value = row[column] ?? ''
				const haystack = input.ignoreCase ? value.toLocaleLowerCase() : value
				if (!haystack.includes(input.needle)) continue
				matches.push({ sheetRow, column: column + 1, a1: `${indexToColumnLetters(column)}${sheetRow}`, value, exactVerified: true })
				if (matches.length >= input.limit || matches.length >= input.expectedMatches) {
					return { ok: true, matches, scannedRows: scannedRows + offset + 1, complete: true, reason: 'found' }
				}
			}
		}
		scannedRows += exactRows.length
	}
	return {
		ok: true,
		matches,
		scannedRows,
		complete: matches.length >= input.expectedMatches,
		reason: matches.length >= input.expectedMatches ? 'found' : 'max-row',
	}
}

async function locateRowsInPage(input: {
	gid: string
	startRow: number
	maxRow: number
	width: number
	candidates: Array<{ exportRow: number; values: string[] }>
	deadlineMs: number
	batchSize?: number
}): Promise<ExactLocatorResult<ExactRowMatch>> {
	const spreadsheetId = getSpreadsheetId()
	const deadlineAt = Date.now() + input.deadlineMs
	const batchSize = Math.min(25, Math.max(1, input.batchSize ?? 10))
	const unmatched = [...input.candidates]
	const matches: ExactRowMatch[] = []
	let scannedRows = 0
	for (let firstRow = input.startRow; firstRow <= input.maxRow; firstRow += batchSize) {
		if (Date.now() >= deadlineAt) return { ok: true, matches, scannedRows, complete: false, reason: 'deadline' }
		const rowNumbers = Array.from({ length: Math.min(batchSize, input.maxRow - firstRow + 1) }, (_, index) => firstRow + index)
		const exactRows = await Promise.all(rowNumbers.map((row) => fetchExactRowInPage(spreadsheetId, input.gid, row, input.width - 1)))
		for (let offset = 0; offset < exactRows.length; offset++) {
			const candidateIndex = unmatched.findIndex((candidate) => exactRowsEqual(exactRows[offset], candidate.values, input.width))
			if (candidateIndex < 0) continue
			const candidate = unmatched.splice(candidateIndex, 1)[0]
			const sheetRow = rowNumbers[offset]
			matches.push({
				...candidate,
				sheetRow,
				a1: `A${sheetRow}:${indexToColumnLetters(input.width - 1)}${sheetRow}`,
				exactVerified: true,
			})
			if (unmatched.length === 0) return { ok: true, matches, scannedRows: scannedRows + offset + 1, complete: true, reason: 'found' }
		}
		scannedRows += exactRows.length
	}
	return { ok: true, matches, scannedRows, complete: unmatched.length === 0, reason: unmatched.length === 0 ? 'found' : 'max-row' }
}

async function fetchExactRowInPage(spreadsheetId: string, gid: string, row: number, lastColumn: number): Promise<string[]> {
	const range = `A${row}:${indexToColumnLetters(Math.max(0, lastColumn))}${row}`
	const params = new URLSearchParams({ tqx: 'out:csv', gid, range })
	const response = await fetch(`${location.origin}/spreadsheets/d/${spreadsheetId}/gviz/tq?${params.toString()}`, { credentials: 'include' })
	const csv = await response.text()
	if (!response.ok) throw new Error(`Exact row read failed for ${range}: HTTP ${response.status} ${csv.slice(0, 120)}`)
	return parseCsvInPage(csv)[0] ?? []
}

function exactRowsEqual(actual: string[], expected: string[], width: number): boolean {
	for (let column = 0; column < width; column++) if ((actual[column] ?? '') !== (expected[column] ?? '')) return false
	return true
}
