import type { CellValue } from './typedValues.js'

/** Dual-MIME clipboard payload used for typed rectangular Google Sheets paste. */
export type TypedClipboardPayload = { text: string; html: string; rows: number; columns: number }

/** Serialize a rectangular typed matrix as plain TSV plus geometry-preserving HTML table. */
export const buildTypedClipboardPayload = (values: readonly (readonly CellValue[])[]): TypedClipboardPayload => {
	if (values.length === 0 || values[0].length === 0 || values.some((row) => row.length !== values[0].length)) {
		throw new Error('Typed clipboard values must be a non-empty rectangular matrix.')
	}
	if (values.every((row) => row.every((value) => value === null))) throw new Error('All-null input must use native clear, not the clipboard.')
	const text = values.map((row) => row.map(plainCell).join('\t')).join('\n')
	const rows = values.map((row) => `<tr>${row.map(htmlCell).join('')}</tr>`).join('')
	// Sheets only honours `data-sheets-value` inside its own copy envelope. Without the wrapper it
	// re-parses the visible text instead, so "123", "0123" and "TRUE" silently become number/boolean.
	const html = `<google-sheets-html-origin><table data-sheets-root="1">${rows}</table></google-sheets-html-origin>`
	return { text, html, rows: values.length, columns: values[0].length }
}

/**
 * The `text/plain` fallback, used only if Sheets ever ignores the HTML flavour.
 *
 * It cannot express types, so text keeps its apostrophe prefix and everything else is stringified.
 * A locale that renders `1.5` as text instead of a number shows up as a verification mismatch rather
 * than as silently wrong data.
 */
const plainCell = (value: CellValue): string => {
	if (value === null) return ''
	if (typeof value === 'object') return value.formula.replace(/\r?\n/g, ' ')
	if (typeof value === 'string') return `'${value.replace(/\r?\n/g, ' ')}`
	return String(value)
}

const htmlCell = (value: CellValue): string => {
	if (value === null) return '<td></td>'
	// A formula is the one thing the envelope does NOT take from an attribute: inside the wrapper
	// `data-sheets-formula` is parsed as R1C1 (that is what a Sheets copy emits), so an A1 source there
	// stores as `#ERROR!`. The visible cell text is parsed as A1 in the document locale instead.
	if (typeof value === 'object') return `<td>${escapeHtml(value.formula)}</td>`
	const sheetsValue = buildSheetsValue(value)
	return `<td data-sheets-value="${escapeHtml(JSON.stringify(sheetsValue))}">${escapeHtml(String(value))}</td>`
}

const buildSheetsValue = (value: string | number | boolean): Record<number, string | number | boolean> => {
	if (typeof value === 'number') return { 1: 3, 3: value }
	if (typeof value === 'boolean') return { 1: 4, 4: value }
	return { 1: 2, 2: value.replace(/\r?\n/g, ' ') }
}

const escapeHtml = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
