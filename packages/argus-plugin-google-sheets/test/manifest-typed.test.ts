import { describe, expect, test } from 'bun:test'
import { hashManifestSnapshot, parseSheetManifest } from '../src/manifest.js'
import { parseCompactCellValue } from '../src/rawCellValues.js'
import { buildTypedClipboardPayload } from '../src/typedClipboard.js'
import { parseCellValue, shiftedRawValueMatches } from '../src/typedValues.js'

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

	test('reads raw number, text, boolean, clear, and formula from Sheets UI copy data', () => {
		expect(parseCompactCellValue({ compact: '{"3":{"1":[1],"3":[1.5]}}', text: '31.12', formula: null })).toEqual({
			value: 1.5,
			formatted: '31.12',
			formula: null,
		})
		expect(parseCompactCellValue({ compact: '{"3":{"1":[2],"4":["1.5"]}}', text: '1.5', formula: null }).value).toBe('1.5')
		expect(parseCompactCellValue({ compact: '{"3":{"1":[3],"5":[{"4":0}]}}', text: 'FALSE', formula: null }).value).toBe(false)
		expect(parseCompactCellValue({ compact: '{"3":{}}', text: '', formula: null }).value).toBeNull()
		expect(parseCompactCellValue({ compact: '{"3":{"1":[1],"3":[3]}}', text: '3', formula: '=D2*2' }).formula).toBe('=D2*2')
	})

	test('accepts Sheets formula reference rewriting during a verified structural shift', () => {
		expect(shiftedRawValueMatches({ value: 7, formatted: '7', formula: '=D6*2' }, { value: 7, formatted: '7', formula: '=D5*2' })).toBe(true)
		expect(shiftedRawValueMatches({ value: 8, formatted: '8', formula: '=D6*2' }, { value: 7, formatted: '7', formula: '=D5*2' })).toBe(false)
	})

	test('uses exact temporary formulas so decimal numbers are locale independent', () => {
		const payload = buildTypedClipboardPayload([[1.5, 2, '1.5', true, { formula: '=A1*2' }, null]])
		expect(payload.text).toStartWith('=15/10\t2\t')
		expect(payload.html).toContain('data-sheets-formula="=15/10"')
		expect(payload.html).toContain('data-sheets-value="{&quot;1&quot;:3,&quot;3&quot;:2}"')
		expect(payload.html).toContain('data-sheets-value="{&quot;1&quot;:2,&quot;2&quot;:&quot;1.5&quot;}"')
		expect(payload.html).toContain('data-sheets-formula="=A1*2"')
		expect(payload.html).toEndWith('<td></td></tr></table>')
	})

	test('produces stable snapshot hashes', () => {
		expect(hashManifestSnapshot({ b: 2, a: 1 })).toBe(hashManifestSnapshot({ a: 1, b: 2 }))
	})
})
