import { describe, expect, test } from 'bun:test'
import { hashManifestSnapshot, parseSheetManifest } from '../src/manifest.js'
import { buildTypedClipboardPayload } from '../src/typedClipboard.js'
import { compareTypedMatrix, parseCellValue, shiftedRawValueMatches, typedValueMatches, type RawCellValue } from '../src/typedValues.js'

const cell = (overrides: Partial<RawCellValue>): RawCellValue => ({
	value: null,
	formatted: null,
	hasFormula: false,
	formula: null,
	error: null,
	...overrides,
})

describe('manifest and typed values', () => {
	test('validates versioned semantic operations and mandatory expectations', () => {
		const manifest = parseSheetManifest({
			version: 1,
			operations: [
				{ op: 'updateByKey', sheet: 'August', keyColumn: 'id', valueColumn: 'icon', changes: { '872': { expect: 'old', set: 'new' } } },
			],
		})
		expect(typeof manifest).not.toBe('string')
		expect(parseSheetManifest({ version: 2, operations: [] })).toContain('version must be 1')
		expect(parseSheetManifest({ version: 1, operations: [{ op: 'setCells', sheet: 'S', cells: { A1: { set: 1 } } }] })).toContain(
			'needs expect and set',
		)
	})

	test('distinguishes text, number, boolean, formula, and clear', () => {
		expect(parseCellValue('0.5', 'x')).toBe('0.5')
		expect(parseCellValue(0.5, 'x')).toBe(0.5)
		expect(parseCellValue(true, 'x')).toBe(true)
		expect(parseCellValue(null, 'x')).toBeNull()
		expect(parseCellValue({ formula: '=A1/2' }, 'x')).toEqual({ formula: '=A1/2' })
		expect(parseCellValue('', 'x')).toBeInstanceOf(Error)
	})

	test('matches plain scalars, blanks, and resolved formula sources', () => {
		expect(typedValueMatches(cell({ value: 1.5, formatted: '1,5' }), 1.5)).toBe(true)
		expect(typedValueMatches(cell({ value: 0 }), -0)).toBe(true)
		expect(typedValueMatches(cell({ value: 'text' }), 'text')).toBe(true)
		expect(typedValueMatches(cell({}), null)).toBe(true)
		expect(typedValueMatches(cell({ value: '' }), null)).toBe(true)
		expect(typedValueMatches(cell({ value: 3, hasFormula: true, formula: '=D2*2' }), { formula: '=D2*2' })).toBe(true)
	})

	test('refuses a formula, an error, or an unread source where a plain value was expected', () => {
		// The decimal trick leaves `=15/10` behind when the paste-values step fails; it must not pass as 1.5.
		expect(typedValueMatches(cell({ value: 1.5, hasFormula: true, formula: '=15/10' }), 1.5)).toBe(false)
		// `=""` renders as an empty cell in CSV, so only the raw read can reject it as a clear.
		expect(typedValueMatches(cell({ value: '', hasFormula: true, formula: '=""' }), null)).toBe(false)
		const errorCell = cell({ value: null, formatted: '#DIV/0!', hasFormula: true, formula: '=1/0', error: '#DIV/0!' })
		expect(typedValueMatches(errorCell, null)).toBe(false)
		expect(typedValueMatches(errorCell, 0)).toBe(false)
		expect(typedValueMatches(errorCell, '#DIV/0!')).toBe(false)
		expect(typedValueMatches(errorCell, { formula: '=1/0' })).toBe(true)
		// `formula: null` on a formula cell means "source not read", never "no formula".
		expect(typedValueMatches(cell({ value: 3, hasFormula: true }), { formula: '=D2*2' })).toBe(false)
	})

	test('names the reason a raw cell failed its expectation', () => {
		const actual = [[cell({ value: 1.5, hasFormula: true, formula: '=15/10' })], [cell({ value: 3, hasFormula: true })]]
		const mismatches = compareTypedMatrix('A1:A2', actual, [[1.5], [{ formula: '=D2*2' }]])
		expect(mismatches.map((mismatch) => [mismatch.a1, mismatch.reason])).toEqual([
			['A1', 'expected number, got formula'],
			['A2', 'formula source not read'],
		])
		expect(compareTypedMatrix('A1', [[cell({ error: '#DIV/0!', formatted: '#DIV/0!' })]], [[null]])[0].reason).toBe('expected clear, got error')
	})

	test('accepts Sheets formula reference rewriting during a verified structural shift', () => {
		const before = cell({ value: 7, formatted: '7', hasFormula: true, formula: '=D5*2' })
		expect(shiftedRawValueMatches(cell({ value: 7, formatted: '7', hasFormula: true, formula: '=D6*2' }), before)).toBe(true)
		expect(shiftedRawValueMatches(cell({ value: 8, formatted: '8', hasFormula: true, formula: '=D6*2' }), before)).toBe(false)
		// The shift check never reads formula sources, so presence alone must still be compared.
		expect(shiftedRawValueMatches(cell({ value: 7, formatted: '7' }), before)).toBe(false)
	})

	test('types every cell through the copy envelope instead of the visible text', () => {
		const payload = buildTypedClipboardPayload([[1.5, 2, '1.5', true, { formula: '=A1*2' }, null]])
		expect(payload.text).toStartWith("1.5\t2\t'1.5\t")
		// A decimal is a plain number now; the `=15/10` locale trick and its paste-values pass are gone.
		expect(payload.html).toContain('data-sheets-value="{&quot;1&quot;:3,&quot;3&quot;:1.5}"')
		expect(payload.html).toContain('data-sheets-value="{&quot;1&quot;:3,&quot;3&quot;:2}"')
		expect(payload.html).toContain('data-sheets-value="{&quot;1&quot;:2,&quot;2&quot;:&quot;1.5&quot;}"')
		// A formula must stay plain text in the cell; `data-sheets-formula` is R1C1 inside the envelope.
		expect(payload.html).toContain('<td>=A1*2</td>')
		expect(payload.html).not.toContain('data-sheets-formula')
		// Without the copy envelope Sheets ignores every data-sheets-value and re-parses the text.
		expect(payload.html).toStartWith('<google-sheets-html-origin><table data-sheets-root="1"><tr>')
		expect(payload.html).toEndWith('<td></td></tr></table></google-sheets-html-origin>')
	})

	test('produces stable snapshot hashes', () => {
		expect(hashManifestSnapshot({ b: 2, a: 1 })).toBe(hashManifestSnapshot({ a: 1, b: 2 }))
	})
})
