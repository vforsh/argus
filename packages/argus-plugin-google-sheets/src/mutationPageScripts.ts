import {
	columnLettersToIndex,
	delay,
	expandA1RangeForShape,
	findVisibleGridGid,
	getCurrentGid,
	getSpreadsheetId,
	indexToColumnLetters,
	isRenderedElement,
	parseA1Cell,
	parseCsvInPage,
	readSheetCsvInPage,
	selectSheetRangeInPage,
	splitA1Range,
	writeClipboardInPage,
} from './pageScripts.js'

export type SheetPreparedWriteResult = {
	ok: true
	method: 'ui-paste'
	range: string
	verificationRange: string
	clipboard: string
}

export type SheetCellMismatch = {
	a1: string
	row: number
	column: number
	expected: string
	actual: string
}

export type SheetWriteVerificationResult = {
	ok: true
	range: string
	verified: boolean
	attempts: number
	mismatches: SheetCellMismatch[]
}

export const buildPrepareWriteExpression = (input: { range: string; text: string; rowCount: number; columnCount: number }): string => `(() => {
${[selectSheetRangeInPage, writeClipboardInPage, expandA1RangeForShape, splitA1Range, parseA1Cell, columnLettersToIndex, indexToColumnLetters].map((helper) => helper.toString()).join('\n')}
${prepareUiWriteInPage.toString()}
return prepareUiWriteInPage(${JSON.stringify(input)})
})()`

export const buildVerifyWriteExpression = (input: { range: string; expectedValues: string[][]; timeoutMs: number }): string => `(() => {
${verificationHelpers.map((helper) => helper.toString()).join('\n')}
${verifyWriteInPage.toString()}
return verifyWriteInPage(${JSON.stringify(input)})
})()`

export const buildVerifyClearExpression = (input: { range: string; timeoutMs: number }): string => `(() => {
${verificationHelpers.map((helper) => helper.toString()).join('\n')}
${verifyClearInPage.toString()}
return verifyClearInPage(${JSON.stringify(input)})
})()`

const verificationHelpers = [
	getSpreadsheetId,
	getCurrentGid,
	findVisibleGridGid,
	isRenderedElement,
	readSheetCsvInPage,
	parseCsvInPage,
	compareValues,
	compareCleared,
	a1ForOffset,
	parseA1RangeBounds,
	splitA1Range,
	parseA1Cell,
	columnLettersToIndex,
	indexToColumnLetters,
	delay,
]

async function prepareUiWriteInPage(input: {
	range: string
	text: string
	rowCount: number
	columnCount: number
}): Promise<SheetPreparedWriteResult> {
	const selected = await selectSheetRangeInPage({ range: input.range })
	const copied = await writeClipboardInPage({ text: input.text })
	return {
		ok: true,
		method: 'ui-paste',
		range: selected.range,
		verificationRange: expandA1RangeForShape(input.range, input.rowCount, input.columnCount),
		clipboard: copied.method,
	}
}

async function verifyWriteInPage(input: { range: string; expectedValues: string[][]; timeoutMs: number }): Promise<SheetWriteVerificationResult> {
	const deadline = Date.now() + input.timeoutMs
	let attempts = 0
	let mismatches: SheetCellMismatch[] = []
	while (Date.now() < deadline) {
		attempts++
		const result = await readSheetCsvInPage({ range: input.range })
		mismatches = compareValues(parseCsvInPage(result.csv), input.expectedValues, input.range)
		if (mismatches.length === 0) {
			return { ok: true, range: input.range, verified: true, attempts, mismatches }
		}
		await delay(100)
	}
	return { ok: true, range: input.range, verified: false, attempts, mismatches }
}

async function verifyClearInPage(input: { range: string; timeoutMs: number }): Promise<SheetWriteVerificationResult> {
	const deadline = Date.now() + input.timeoutMs
	let attempts = 0
	let mismatches: SheetCellMismatch[] = []
	while (Date.now() < deadline) {
		attempts++
		const result = await readSheetCsvInPage({ range: input.range })
		mismatches = compareCleared(parseCsvInPage(result.csv), input.range)
		if (mismatches.length === 0) {
			return { ok: true, range: input.range, verified: true, attempts, mismatches }
		}
		await delay(100)
	}
	return { ok: true, range: input.range, verified: false, attempts, mismatches }
}

function compareValues(actual: string[][], expected: string[][], range: string): SheetCellMismatch[] {
	const mismatches: SheetCellMismatch[] = []
	const rows = expected.length
	const columns = Math.max(0, ...expected.map((row) => row.length))
	for (let row = 0; row < rows; row++) {
		for (let column = 0; column < columns; column++) {
			const expectedValue = expected[row]?.[column] ?? ''
			const actualValue = actual[row]?.[column] ?? ''
			if (actualValue !== expectedValue) {
				mismatches.push({
					a1: a1ForOffset(range, row, column),
					row: row + 1,
					column: column + 1,
					expected: expectedValue,
					actual: actualValue,
				})
				if (mismatches.length >= 50) return mismatches
			}
		}
	}
	return mismatches
}

function compareCleared(actual: string[][], range: string): SheetCellMismatch[] {
	const bounds = parseA1RangeBounds(range)
	const rows = bounds?.rowCount ?? actual.length
	const columns = bounds?.columnCount ?? Math.max(0, ...actual.map((row) => row.length))
	const mismatches: SheetCellMismatch[] = []
	for (let row = 0; row < rows; row++) {
		for (let column = 0; column < columns; column++) {
			const actualValue = actual[row]?.[column] ?? ''
			if (actualValue !== '') {
				mismatches.push({ a1: a1ForOffset(range, row, column), row: row + 1, column: column + 1, expected: '', actual: actualValue })
				if (mismatches.length >= 50) return mismatches
			}
		}
	}
	return mismatches
}

function a1ForOffset(range: string, rowOffset: number, columnOffset: number): string {
	const bounds = parseA1RangeBounds(range)
	if (!bounds) return `R${rowOffset + 1}C${columnOffset + 1}`

	const sheetPrefix = bounds.sheet ? `${bounds.sheet}!` : ''
	return `${sheetPrefix}${indexToColumnLetters(bounds.startColumn + columnOffset)}${bounds.startRow + rowOffset + 1}`
}

function parseA1RangeBounds(
	range: string,
): { sheet: string | null; startColumn: number; startRow: number; rowCount: number; columnCount: number } | null {
	const [startValue, endValue] = splitA1Range(range)
	const start = parseA1Cell(startValue)
	if (!start) return null

	const end = endValue ? parseA1Cell(`${start.sheet ? `${start.sheet}!` : ''}${endValue.replace(/^.*!/, '')}`) : start
	if (!end) return null

	return {
		sheet: start.sheet,
		startColumn: Math.min(start.column, end.column),
		startRow: Math.min(start.row, end.row),
		rowCount: Math.abs(end.row - start.row) + 1,
		columnCount: Math.abs(end.column - start.column) + 1,
	}
}
