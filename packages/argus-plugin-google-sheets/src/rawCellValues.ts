import type { ArgusPluginContextV1 } from '@vforsh/argus-plugin-api'
import { randomUUID } from 'node:crypto'
import { a1ForOffset } from './a1.js'
import { parseCompactTable, type CompactCell } from './compactTable.js'
import { dispatchKey, evalInWatcher, selectRange, type Output } from './sheetCommandUtils.js'
import type { RawCellValue } from './typedValues.js'

const COMPACT_TABLE_MIME = 'application/x-vnd.google-spreadsheet-compact-table+json'
/** The formula bar is repainted asynchronously after a selection; poll rather than sleep longer. */
const FORMULA_BAR_TIMEOUT_MS = 1_000

/**
 * Which formula cells need their A1 source read from the formula bar.
 *
 * Each resolved cell costs a selection plus an eval, so callers that only compare against scalars
 * pass `'none'` (or a predicate) and rely on {@link RawCellValue.hasFormula}, which the rectangle
 * copy reports for free.
 */
export type FormulaSourceResolution = 'all' | 'none' | ((row: number, column: number) => boolean)

type CopyCapture = { ok: true; token: string; compact: string; text: string }
type FormulaBarSource = { ok: true; source: string | null; settled: boolean }

/**
 * Read an exact raw rectangle through one Sheets selection and one UI copy.
 *
 * Costs three watcher round trips regardless of size, plus two per formula cell whose source
 * `resolveFormulaSources` asks for.
 *
 * @throws When the copied geometry disagrees with the requested shape (the selection did not take),
 * when the payload shape drifted, or when the formula bar does not show a formula source.
 */
export const readTypedMatrix = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	output: Output,
	input: { range: string; rows: number; columns: number; resolveFormulaSources?: FormulaSourceResolution },
): Promise<RawCellValue[][] | null> => {
	if (!(await selectRange(ctx, id, input.range, output))) return null
	const token = randomUUID()
	if (!(await evalInWatcher(ctx, id, buildInstallCopyCaptureExpression(token), output))) return null
	if (!(await dispatchKey(ctx, id, output, { key: 'c', modifiers: 'ctrl' }))) return null
	const capture = await evalInWatcher<CopyCapture>(ctx, id, buildReadCopyCaptureExpression(token), output)
	if (!capture) return null

	const cells = parseCompactTable(capture)
	if (cells.length !== input.rows || cells[0].length !== input.columns) {
		throw new Error(
			`Google Sheets copied a ${cells.length}x${cells[0].length} rectangle for ${input.range}, expected ${input.rows}x${input.columns}.`,
		)
	}
	const matrix = cells.map((row) => row.map(toRawCellValue))
	return await readFormulaSources(ctx, id, output, input.range, matrix, toFormulaPredicate(input.resolveFormulaSources ?? 'all'))
}

const toRawCellValue = (cell: CompactCell): RawCellValue => ({
	value: cell.value,
	formatted: cell.formatted,
	hasFormula: cell.hasFormula,
	formula: null,
	error: cell.error,
})

const toFormulaPredicate = (resolution: FormulaSourceResolution): ((row: number, column: number) => boolean) => {
	if (resolution === 'all') return () => true
	if (resolution === 'none') return () => false
	return resolution
}

/** Fill in `formula` for the requested formula cells; the copy payload never carries an A1 source. */
const readFormulaSources = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	output: Output,
	range: string,
	matrix: RawCellValue[][],
	wanted: (row: number, column: number) => boolean,
): Promise<RawCellValue[][] | null> => {
	let previous: string | null = null
	for (let row = 0; row < matrix.length; row++) {
		for (let column = 0; column < matrix[row].length; column++) {
			const cell = matrix[row][column]
			if (!cell.hasFormula || !wanted(row, column)) continue
			const a1 = a1ForOffset(range, row, column)
			if (!(await selectRange(ctx, id, a1, output))) return null
			const result: FormulaBarSource | null = await evalInWatcher<FormulaBarSource>(
				ctx,
				id,
				buildReadFormulaBarSourceExpression(previous),
				output,
			)
			if (!result) return null
			if (!result.source?.startsWith('=')) {
				throw new Error(`Google Sheets formula bar showed ${JSON.stringify(result.source)} for ${a1}, which is not a formula source.`)
			}
			cell.formula = result.source
			previous = result.source
		}
	}
	return matrix
}

/** Build a one-shot page copy listener for an exact raw rectangle read. */
export const buildInstallCopyCaptureExpression = (token: string): string =>
	`(${installCopyCaptureInPage.toString()})(${JSON.stringify({ token, mime: COMPACT_TABLE_MIME })})`

/** Build a page expression that consumes one matching copy capture. */
export const buildReadCopyCaptureExpression = (token: string): string => `(${readCopyCaptureInPage.toString()})(${JSON.stringify({ token })})`

/** Build a page expression that reads the formula bar once the selection has repainted it. */
export const buildReadFormulaBarSourceExpression = (previous: string | null): string =>
	`(${readFormulaBarSourceInPage.toString()})(${JSON.stringify({ previous, timeoutMs: FORMULA_BAR_TIMEOUT_MS })})`

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

function readCopyCaptureInPage(input: { token: string }): CopyCapture {
	const root = globalThis as typeof globalThis & { __argusSheetsCopyCaptureV1?: { token: string; compact: string; text: string } }
	const capture = root.__argusSheetsCopyCaptureV1
	delete root.__argusSheetsCopyCaptureV1
	if (!capture || capture.token !== input.token || !capture.compact) throw new Error('Google Sheets raw copy capture was missing or stale.')
	return { ok: true, token: input.token, compact: capture.compact, text: capture.text }
}

async function readFormulaBarSourceInPage(input: { previous: string | null; timeoutMs: number }): Promise<FormulaBarSource> {
	const selectors = [
		'#t-formula-bar-input .cell-input',
		'#t-formula-bar-input',
		'[aria-label="Formula bar"] .cell-input',
		'[aria-label="Formula bar"]',
	]
	const read = (): string | null => {
		for (const selector of selectors) {
			const element = document.querySelector<HTMLElement>(selector)
			if (!element) continue
			return (element.textContent ?? (element as HTMLInputElement).value ?? '').trim()
		}
		return null
	}
	if (read() === null) throw new Error('Google Sheets formula bar was not found for raw formula-source verification.')
	const deadline = Date.now() + input.timeoutMs
	let source = read() ?? ''
	while ((source === '' || source === input.previous) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 25))
		source = read() ?? ''
	}
	// Not settling is not an error: two cells may legitimately hold the same source text.
	return { ok: true, source: source || null, settled: source !== input.previous }
}
