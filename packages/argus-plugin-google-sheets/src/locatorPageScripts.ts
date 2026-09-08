import { advanceLocator, planLocatorProbes, retryDelaysMs } from './locatorModel.js'
import { indexToColumnLetters } from './pageA1.js'
import { delay, getSpreadsheetId, parseCsvInPage } from './sheetDataPageScripts.js'

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

/** Build a bounded exact-cell locator for corrected `find`. */
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
	candidates: Array<{ exportRow: number; exportColumn: number }>
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

const locatorHelpers = [
	getSpreadsheetId,
	parseCsvInPage,
	indexToColumnLetters,
	delay,
	planLocatorProbes,
	advanceLocator,
	retryDelaysMs,
	fetchExactRowInPage,
	exactRowsEqual,
	rowContainsNeedle,
]
const buildLocatorExpression = <T>(fn: (input: T) => unknown, input: T): string => `(() => {
${locatorHelpers.map((helper) => helper.toString()).join('\n')}
return (${fn.toString()})(${JSON.stringify(input)})
})()`

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
	const candidates = [...input.candidates].sort((left, right) => left.exportRow - right.exportRow)
	const matches: ExactRowMatch[] = []
	let scannedRows = 0
	let offset = 0
	let minRow = input.startRow
	for (const candidate of candidates) {
		let probed = 0
		let located = false
		while (!located) {
			if (Date.now() >= deadlineAt) return { ok: true, matches, scannedRows, complete: false, reason: 'deadline' }
			const probes = planLocatorProbes({ exportRow: candidate.exportRow, offset, probed, minRow, maxRow: input.maxRow, batchSize })
			if (probes.length === 0) return { ok: true, matches, scannedRows, complete: false, reason: 'max-row' }
			const rows = await Promise.all(probes.map((row) => fetchExactRowInPage(spreadsheetId, input.gid, row, input.width - 1, deadlineAt)))
			scannedRows += rows.length
			probed += rows.length
			for (let index = 0; index < rows.length; index++) {
				if (!exactRowsEqual(rows[index], candidate.values, input.width)) continue
				const sheetRow = probes[index]
				matches.push({ ...candidate, sheetRow, a1: `A${sheetRow}:${indexToColumnLetters(input.width - 1)}${sheetRow}`, exactVerified: true })
				offset = advanceLocator(offset, candidate.exportRow, sheetRow)
				minRow = sheetRow + 1
				located = true
				break
			}
		}
	}
	return { ok: true, matches, scannedRows, complete: true, reason: 'found' }
}

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
	candidates: Array<{ exportRow: number; exportColumn: number }>
	deadlineMs: number
	batchSize?: number
}): Promise<ExactLocatorResult<ExactCellMatch>> {
	const spreadsheetId = getSpreadsheetId()
	const deadlineAt = Date.now() + input.deadlineMs
	const batchSize = Math.min(25, Math.max(1, input.batchSize ?? 10))
	// One export row can hold several matching cells; locate the row once and emit every cell in it.
	const exportRows = [...new Set(input.candidates.map((candidate) => candidate.exportRow))].sort((left, right) => left - right)
	const start = input.columnIndex ?? input.firstColumn ?? 0
	const end = input.columnIndex ?? input.lastColumn
	const matches: ExactCellMatch[] = []
	let scannedRows = 0
	let offset = 0
	let minRow = input.startRow
	for (const exportRow of exportRows) {
		let probed = 0
		let located = false
		while (!located) {
			if (Date.now() >= deadlineAt) return { ok: true, matches, scannedRows, complete: false, reason: 'deadline' }
			const probes = planLocatorProbes({ exportRow, offset, probed, minRow, maxRow: input.maxRow, batchSize })
			if (probes.length === 0) return { ok: true, matches, scannedRows, complete: false, reason: 'max-row' }
			const rows = await Promise.all(probes.map((row) => fetchExactRowInPage(spreadsheetId, input.gid, row, input.lastColumn, deadlineAt)))
			scannedRows += rows.length
			probed += rows.length
			for (let index = 0; index < rows.length; index++) {
				if (!rowContainsNeedle(rows[index], input.needle, start, end, input.ignoreCase)) continue
				const sheetRow = probes[index]
				for (let column = start; column <= end; column++) {
					const value = rows[index][column] ?? ''
					if (!(input.ignoreCase ? value.toLocaleLowerCase() : value).includes(input.needle)) continue
					matches.push({ sheetRow, column: column + 1, a1: `${indexToColumnLetters(column)}${sheetRow}`, value, exactVerified: true })
					if (matches.length >= input.limit) return { ok: true, matches, scannedRows, complete: true, reason: 'found' }
				}
				offset = advanceLocator(offset, exportRow, sheetRow)
				minRow = sheetRow + 1
				located = true
				break
			}
		}
	}
	return { ok: true, matches, scannedRows, complete: true, reason: 'found' }
}

/**
 * Read one exact physical row through the authenticated gviz export.
 *
 * Retries throttling and server errors on the shared backoff; anything else, or a spent backoff,
 * throws so the locator fails closed instead of treating a missing row as a non-match.
 */
async function fetchExactRowInPage(spreadsheetId: string, gid: string, row: number, lastColumn: number, deadlineAt: number): Promise<string[]> {
	const range = `A${row}:${indexToColumnLetters(Math.max(0, lastColumn))}${row}`
	const params = new URLSearchParams({ tqx: 'out:csv', gid, range })
	const url = `${location.origin}/spreadsheets/d/${spreadsheetId}/gviz/tq?${params.toString()}`
	for (let attempt = 0; ; attempt++) {
		const response = await fetch(url, { credentials: 'include' })
		const csv = await response.text()
		if (response.ok) return parseCsvInPage(csv)[0] ?? []
		const backoff = response.status === 429 || response.status >= 500 ? retryDelaysMs(attempt) : null
		if (backoff === null || Date.now() + backoff >= deadlineAt) {
			throw new Error(`Exact row read failed for ${range}: HTTP ${response.status} ${csv.slice(0, 120)}`)
		}
		await delay(backoff)
	}
}

function exactRowsEqual(actual: string[], expected: string[], width: number): boolean {
	for (let column = 0; column < width; column++) if ((actual[column] ?? '') !== (expected[column] ?? '')) return false
	return true
}

function rowContainsNeedle(actual: string[], needle: string, start: number, end: number, ignoreCase: boolean): boolean {
	for (let column = start; column <= end; column++) {
		const value = actual[column] ?? ''
		if ((ignoreCase ? value.toLocaleLowerCase() : value).includes(needle)) return true
	}
	return false
}
