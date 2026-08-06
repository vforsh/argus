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
	const html = `<table>${values.map((row) => `<tr>${row.map(htmlCell).join('')}</tr>`).join('')}</table>`
	return { text, html, rows: values.length, columns: values[0].length }
}

const plainCell = (value: CellValue): string => {
	if (value === null) return ''
	if (typeof value === 'object') return value.formula.replace(/\r?\n/g, ' ')
	if (typeof value === 'string') return `'${value.replace(/\r?\n/g, ' ')}`
	if (typeof value === 'number' && !Number.isInteger(value)) return exactNumberFormula(value)
	return String(value)
}
const htmlCell = (value: CellValue): string => {
	if (value === null) return '<td></td>'
	if (typeof value === 'object') return `<td data-sheets-formula="${escapeHtml(value.formula)}">${escapeHtml(value.formula)}</td>`
	if (typeof value === 'number' && !Number.isInteger(value)) {
		const formula = exactNumberFormula(value)
		return `<td data-sheets-formula="${escapeHtml(formula)}">${escapeHtml(formula)}</td>`
	}
	const sheetsValue = buildSheetsValue(value)
	return `<td data-sheets-value="${escapeHtml(JSON.stringify(sheetsValue))}">${escapeHtml(String(value))}</td>`
}

const buildSheetsValue = (value: string | number | boolean): Record<number, string | number | boolean> => {
	if (typeof value === 'number') return { 1: 3, 3: value }
	if (typeof value === 'boolean') return { 1: 4, 4: value }
	return { 1: 2, 2: value.replace(/\r?\n/g, ' ') }
}

const exactNumberFormula = (value: number): string => {
	const [mantissa, exponentText] = Math.abs(value).toString().toLowerCase().split('e')
	const exponent = Number(exponentText ?? 0)
	const [integer, fraction = ''] = mantissa.split('.')
	const digits = `${integer}${fraction}`.replace(/^0+(?=\d)/, '')
	const scale = fraction.length - exponent
	const sign = value < 0 ? '-' : ''
	return scale > 0 ? `=${sign}${digits}/${`1${'0'.repeat(scale)}`}` : `=${sign}${digits}${'0'.repeat(-scale)}`
}
const escapeHtml = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
