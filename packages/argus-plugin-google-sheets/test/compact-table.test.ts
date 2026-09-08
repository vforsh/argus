import { describe, expect, test } from 'bun:test'
import { decodeRunLength, parseCompactTable, type CompactCell } from '../src/compactTable.js'
import blank from './fixtures/compact/blank-2x2.json' with { type: 'json' }
import edge from './fixtures/compact/rect-edge-5x2.json' with { type: 'json' }
import padded from './fixtures/compact/rect-padded-7x6.json' with { type: 'json' }
import rect from './fixtures/compact/rect-5x5.json' with { type: 'json' }
import singleFormula from './fixtures/compact/single-formula.json' with { type: 'json' }
import singleNumber from './fixtures/compact/single-number.json' with { type: 'json' }

const shape = (cells: CompactCell[][]): [number, number] => [cells.length, cells[0].length]
const values = (cells: CompactCell[][]): unknown[][] => cells.map((row) => row.map((cell) => cell.value))
const withCompact = (fixture: { compact: string; text: string }, compact: unknown): { compact: string; text: string } => ({
	compact: typeof compact === 'string' ? compact : JSON.stringify(compact),
	text: fixture.text,
})

describe('compact-table decoder', () => {
	test('expands run-length streams, including plain streams that need no expansion', () => {
		expect(decodeRunLength([-9, 195, 203, -5, 194])).toEqual([...Array(9).fill(195), 203, ...Array(5).fill(194)])
		expect(decodeRunLength([2, 2, 1, 3])).toEqual([2, 2, 1, 3])
		expect(decodeRunLength([])).toEqual([])
		expect(() => decodeRunLength([-3])).toThrow('has no value to repeat')
	})

	test('decodes a mixed rectangle with geometry, blanks, and formula flags preserved', () => {
		const cells = parseCompactTable(rect)
		expect(shape(cells)).toEqual([5, 5])
		expect(values(cells)).toEqual([
			['id', 'name', 'active', 'score', 'formula'],
			[1, 'first', true, 1.5, 3],
			[null, null, null, null, null],
			[2, 'hidden-like', false, 2.5, 5],
			[872, 'promo', true, 3.5, 7],
		])
		expect(cells.map((row) => row.map((cell) => cell.hasFormula))).toEqual([
			[false, false, false, false, false],
			[false, false, false, false, true],
			[false, false, false, false, false],
			[false, false, false, false, true],
			[false, false, false, false, true],
		])
		// Locale formatting stays in `formatted`; the raw value never carries a comma decimal.
		expect(cells[1][3]).toEqual({ value: 1.5, formatted: '1,5', hasFormula: false, error: null })
		expect(cells[2][0]).toEqual({ value: null, formatted: null, hasFormula: false, error: null })
	})

	test('keeps run-length runs that straddle row boundaries aligned with the geometry', () => {
		const cells = parseCompactTable(padded)
		expect(shape(cells)).toEqual([7, 6])
		expect(values(cells)[1]).toEqual([1, 'first', true, 1.5, 3, null])
		expect(values(cells)[5]).toEqual([null, null, null, null, null, null])
		expect(values(cells)[6]).toEqual([null, null, null, null, null, null])
		expect(cells[4][4]).toMatchObject({ value: 7, hasFormula: true })
		expect(cells[4][5]).toMatchObject({ value: null, hasFormula: false })
	})

	test('decodes errors, empty-string formulas, multi-line text, and apostrophe-forced text', () => {
		const cells = parseCompactTable(edge)
		expect(shape(cells)).toEqual([5, 2])
		expect(cells[0][0]).toEqual({ value: null, formatted: '#DIV/0!', hasFormula: true, error: '#DIV/0!' })
		expect(cells[3][0]).toEqual({ value: null, formatted: '#ERROR!', hasFormula: true, error: '#ERROR!' })
		// `=""` is a real text value, not a clear -- which is exactly what the clear guard must catch.
		expect(cells[1][0]).toEqual({ value: '', formatted: null, hasFormula: true, error: null })
		expect(cells[2][0]).toEqual({ value: 'a\nb', formatted: 'a\nb', hasFormula: true, error: null })
		expect(cells[2][1]).toMatchObject({ value: 1e21, formatted: '1,00E+21' })
		expect(cells[4][1]).toMatchObject({ value: 'Дебит', hasFormula: true })
	})

	test('decodes a format-only rectangle as fully blank', () => {
		const cells = parseCompactTable(blank)
		expect(shape(cells)).toEqual([2, 2])
		expect(values(cells)).toEqual([
			[null, null],
			[null, null],
		])
		expect(cells.every((row) => row.every((cell) => !cell.hasFormula && cell.error === null))).toBe(true)
	})

	test('parses single-cell payloads the same way as rectangles', () => {
		expect(parseCompactTable(singleNumber)).toEqual([[{ value: 1.5, formatted: '1,5', hasFormula: false, error: null }]])
		expect(parseCompactTable(singleFormula)).toEqual([[{ value: 3, formatted: '3', hasFormula: true, error: null }]])
	})

	test('falls back to the raw value when the TSV shape disagrees with the geometry', () => {
		const cells = parseCompactTable({ compact: rect.compact, text: 'only one line' })
		expect(cells[1][3]).toEqual({ value: 1.5, formatted: '1.5', hasFormula: false, error: null })
		expect(cells[2][0].formatted).toBeNull()
		expect(cells[0][0].formatted).toBe('id')
	})

	test('fails closed on every payload-shape deviation', () => {
		const payload = JSON.parse(rect.compact) as Record<string, unknown>
		expect(() => parseCompactTable({ compact: 'not json', text: '' })).toThrow('valid compact-table JSON')
		expect(() => parseCompactTable(withCompact(rect, { ...payload, 15: undefined }))).toThrow('geometry) is missing')
		expect(() => parseCompactTable(withCompact(rect, { ...payload, 20: 24 }))).toThrow('does not match cell count 24')
		expect(() => parseCompactTable(withCompact(rect, { ...payload, 2: [-9, 195] }))).toThrow('expanded to 9 cells, expected 25')
		expect(() => parseCompactTable(withCompact(rect, { ...payload, 9: [0, 1] }))).toThrow('expanded to 2 entries, expected 3')
		expect(() => parseCompactTable(withCompact(rect, { ...payload, 8: [] }))).toThrow('outside the 0-entry formula list')

		const streams = payload['3'] as Record<string, unknown>
		const types = streams['1'] as number[]
		expect(() => parseCompactTable(withCompact(rect, { ...payload, 3: { ...streams, 3: [1] } }))).toThrow('number stream entry 1 is undefined')
		expect(() => parseCompactTable(withCompact(rect, { ...payload, 3: { ...streams, 1: types.slice(0, 19) } }))).toThrow('fewer than the flag')
		expect(() => parseCompactTable(withCompact(rect, { ...payload, 3: { ...streams, 1: [...types, 1] } }))).toThrow('1 unconsumed entries')
		expect(() => parseCompactTable(withCompact(rect, { ...payload, 3: { ...streams, 1: [5, ...types.slice(1)] } }))).toThrow(
			'unsupported value type 5',
		)
		expect(() => parseCompactTable(withCompact(edge, JSON.parse(edge.compact.replace('"1":5,"5"', '"1":7,"5"')) as unknown))).toThrow(
			'structured entry is',
		)
	})
})
