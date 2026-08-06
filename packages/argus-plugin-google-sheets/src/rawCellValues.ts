import type { ArgusPluginContextV1 } from '@vforsh/argus-plugin-api'
import { randomUUID } from 'node:crypto'
import { a1ForOffset } from './a1.js'
import { dispatchKey, evalInWatcher, selectRange, type Output } from './sheetCommandUtils.js'
import type { RawCellValue } from './typedValues.js'

const COMPACT_TABLE_MIME = 'application/x-vnd.google-spreadsheet-compact-table+json'

type CellCopyCapture = { ok: true; token: string; compact: string; text: string; formula: string | null }

/** Parse one Google Sheets UI-copy payload into its underlying typed value. */
export const parseCompactCellValue = (input: { compact: string; text: string; formula: string | null }): RawCellValue => {
	let value: unknown
	try {
		value = JSON.parse(input.compact)
	} catch {
		throw new Error('Google Sheets copy did not provide valid compact-table JSON for raw verification.')
	}
	if (!isRecord(value)) throw new Error('Google Sheets compact-table copy payload is malformed.')
	const cells = isRecord(value['3']) ? value['3'] : null
	const type = firstCompactValue(cells, '1')
	const formula = input.formula?.startsWith('=') ? input.formula : null
	switch (type) {
		case null:
			return { value: null, formatted: input.text || null, formula }
		case 1:
			return parseCompactNumber(cells, input.text, formula)
		case 2:
			return parseCompactText(cells, input.text, formula)
		case 3:
			return parseCompactBoolean(cells, input.text, formula)
		default:
			throw new Error(`Google Sheets copied unsupported raw cell type ${String(type)}.`)
	}
}

const parseCompactNumber = (cells: Record<string, unknown> | null, text: string, formula: string | null): RawCellValue => {
	const value = firstCompactValue(cells, '3')
	if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Google Sheets numeric copy payload is malformed.')
	return { value, formatted: text || null, formula }
}

const parseCompactText = (cells: Record<string, unknown> | null, text: string, formula: string | null): RawCellValue => {
	const value = firstCompactValue(cells, '4')
	if (typeof value !== 'string') throw new Error('Google Sheets text copy payload is malformed.')
	return { value, formatted: text || value, formula }
}

const parseCompactBoolean = (cells: Record<string, unknown> | null, text: string, formula: string | null): RawCellValue => {
	const encodedCell = firstCompactValue(cells, '5')
	const encoded = isRecord(encodedCell) ? encodedCell['4'] : null
	if (encoded !== 0 && encoded !== 1 && typeof encoded !== 'boolean') throw new Error('Google Sheets boolean copy payload is malformed.')
	return { value: encoded === 1 || encoded === true, formatted: text || null, formula }
}

const firstCompactValue = (cells: Record<string, unknown> | null, key: string): unknown => {
	const values = cells?.[key]
	return Array.isArray(values) ? (values[0] ?? null) : null
}

/** Read exact raw cell types/formulas through the supported Sheets selection and copy UI. */
export const readTypedMatrixFromClipboard = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	output: Output,
	input: { range: string; rows: number; columns: number },
): Promise<RawCellValue[][] | null> => {
	const values: RawCellValue[][] = []
	for (let row = 0; row < input.rows; row++) {
		const cells: RawCellValue[] = []
		for (let column = 0; column < input.columns; column++) {
			const a1 = a1ForOffset(input.range, row, column)
			if (!(await selectRange(ctx, id, a1, output))) return null
			const token = randomUUID()
			if (!(await evalInWatcher(ctx, id, buildInstallCopyCaptureExpression(token), output))) return null
			if (!(await dispatchKey(ctx, id, output, { key: 'c', modifiers: 'ctrl' }))) return null
			const result = await evalInWatcher<CellCopyCapture>(ctx, id, buildReadCopyCaptureExpression(token), output)
			if (!result) return null
			cells.push(parseCompactCellValue(result))
		}
		values.push(cells)
	}
	return values
}

/** Build a one-shot page copy listener for an exact raw cell read. */
export const buildInstallCopyCaptureExpression = (token: string): string =>
	`(${installCopyCaptureInPage.toString()})(${JSON.stringify({ token, mime: COMPACT_TABLE_MIME })})`

/** Build a page expression that consumes one matching copy capture and formula source. */
export const buildReadCopyCaptureExpression = (token: string): string => `(${readCopyCaptureInPage.toString()})(${JSON.stringify({ token })})`

function installCopyCaptureInPage(input: { token: string; mime: string }): { ok: true; token: string } {
	const root = globalThis as typeof globalThis & { __argusSheetsCopyCaptureV1?: { token: string; compact: string; text: string } }
	delete root.__argusSheetsCopyCaptureV1
	document.addEventListener(
		'copy',
		(event) => {
			root.__argusSheetsCopyCaptureV1 = {
				token: input.token,
				compact: event.clipboardData?.getData(input.mime) ?? '',
				text: event.clipboardData?.getData('text/plain') ?? '',
			}
		},
		{ once: true },
	)
	return { ok: true, token: input.token }
}

function readCopyCaptureInPage(input: { token: string }): CellCopyCapture {
	const root = globalThis as typeof globalThis & { __argusSheetsCopyCaptureV1?: { token: string; compact: string; text: string } }
	const capture = root.__argusSheetsCopyCaptureV1
	delete root.__argusSheetsCopyCaptureV1
	if (!capture || capture.token !== input.token || !capture.compact) throw new Error('Google Sheets raw copy capture was missing or stale.')
	const selectors = [
		'#t-formula-bar-input .cell-input',
		'#t-formula-bar-input',
		'[aria-label="Formula bar"] .cell-input',
		'[aria-label="Formula bar"]',
	]
	for (const selector of selectors) {
		const element = document.querySelector<HTMLElement>(selector)
		if (!element) continue
		const source = (element.textContent ?? (element as HTMLInputElement).value ?? '').trim()
		return { ok: true, token: input.token, compact: capture.compact, text: capture.text, formula: source || null }
	}
	throw new Error('Google Sheets formula bar was not found for raw copy verification.')
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
