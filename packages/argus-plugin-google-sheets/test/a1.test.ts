import { describe, expect, test } from 'bun:test'
import { a1ForOffset, columnLettersToIndex, expandA1RangeForShape, indexToColumnLetters, parseA1Cell, parseA1Range } from '../src/a1.js'

describe('A1 coordinates', () => {
	test('converts columns across boundaries', () => {
		for (const [index, letters] of [
			[0, 'A'],
			[25, 'Z'],
			[26, 'AA'],
			[51, 'AZ'],
			[701, 'ZZ'],
			[702, 'AAA'],
		] as const) {
			expect(indexToColumnLetters(index)).toBe(letters)
			expect(columnLettersToIndex(letters)).toBe(index)
		}
	})

	test('parses quoted sheets, absolute refs, and reversed ranges', () => {
		expect(parseA1Cell("'My Sheet'!$AA$12")).toEqual({ sheet: 'My Sheet', column: 26, row: 11 })
		expect(parseA1Range('C5:A2')).toEqual({ sheet: null, startColumn: 0, startRow: 1, endColumn: 2, endRow: 4 })
	})

	test('expands and offsets physical ranges', () => {
		expect(expandA1RangeForShape('B12', 2, 3)).toBe('B12:D13')
		expect(a1ForOffset("'Sheet 1'!B12:D13", 1, 2)).toBe("'Sheet 1'!D13")
	})
})
