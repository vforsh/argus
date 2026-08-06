import { describe, expect, test } from 'bun:test'
import { buildKeyedRows, diffKeyedRows } from '../src/keyedDiff.js'
import { buildSheetSchema, normalizeHeaderName, resolveHeader } from '../src/schema.js'

describe('headers and keyed diff', () => {
	test('normalizes whitespace/NFKC and reports empty/duplicate headers', () => {
		const schema = buildSheetSchema(['  Name\u00a0', '', 'ＮＡＭＥ'], 7)
		expect(normalizeHeaderName('  Name\u00a0')).toBe('name')
		expect(schema.headers[0]).toMatchObject({ column: 'A', a1: 'A7', duplicate: true, duplicateIndex: 1, duplicateCount: 2 })
		expect(schema.emptyColumns).toEqual(['B'])
		expect(resolveHeader(schema, 'name')).toBe('Header "name" is duplicated; select an unambiguous column letter.')
	})

	test('reports stable additions, removals, and changes', () => {
		const headers = ['id', 'icon']
		const sheet = buildKeyedRows(
			[
				['1', 'old'],
				['2', 'same'],
			],
			headers,
			'id',
			['icon'],
			'Sheet',
		)
		const local = buildKeyedRows(
			[
				['2', 'same'],
				['3', 'new'],
				['1', 'changed'],
			],
			headers,
			'id',
			['icon'],
			'Local',
		)
		if (typeof sheet === 'string' || typeof local === 'string') throw new Error('fixture failed')
		expect(diffKeyedRows(sheet, local, ['icon'])).toMatchObject({
			additions: [{ key: '3' }],
			removals: [],
			changes: [{ key: '1', columns: [{ column: 'icon', before: 'old', after: 'changed' }] }],
			unchanged: 1,
		})
	})

	test('rejects duplicate and missing keys', () => {
		expect(buildKeyedRows([['1'], ['1']], ['id'], 'id', [], 'Sheet')).toContain('duplicate key')
		expect(buildKeyedRows([['']], ['id'], 'id', [], 'Sheet')).toContain('empty key')
	})
})
