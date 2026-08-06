import { describe, expect, test } from 'bun:test'
import {
	exactRowMatchesCandidate,
	findExportHeaderIndex,
	locateCandidate,
	parseSelectHeaders,
	parseWhereExpression,
	queryExportRows,
} from '../src/queryModel.js'
import { buildSheetSchema } from '../src/schema.js'

describe('coordinate-safe query', () => {
	const physical = [['id', 'name'], ['1', 'first'], [], ['2', 'hidden row'], [], ['872', 'promo']]
	const collapsedExport = physical.filter((row) => row.some((cell) => cell !== ''))

	test('keeps export row separate until an exact physical row is proven', () => {
		const schema = buildSheetSchema(physical[0], 1)
		const where = parseWhereExpression('id in [872]', schema)
		if (typeof where === 'string') throw new Error(where)
		const candidates = queryExportRows(collapsedExport, findExportHeaderIndex(collapsedExport, schema), where)
		expect(candidates).toEqual([{ exportRow: 4, values: ['872', 'promo'] }])
		expect('sheetRow' in candidates[0]).toBe(false)
		expect('a1' in candidates[0]).toBe(false)
		expect(exactRowMatchesCandidate(physical[5], candidates[0], 2)).toBe(true)
		expect(locateCandidate(candidates[0], 6)).toMatchObject({ exportRow: 4, sheetRow: 6, a1: 'A6:B6', exactVerified: true })
	})

	test('locates hidden physical rows without trusting collapsed indexes', () => {
		const schema = buildSheetSchema(physical[0], 1)
		const where = parseWhereExpression('name contains hidden', schema)
		if (typeof where === 'string') throw new Error(where)
		const candidate = queryExportRows(collapsedExport, 0, where)[0]
		expect(candidate.exportRow).toBe(3)
		expect(locateCandidate(candidate, 4).sheetRow).toBe(4)
	})

	test('parses operators and stable select order', () => {
		const schema = buildSheetSchema(['Айди акции promoId', 'Иконка icon'], 1)
		expect(parseWhereExpression('Айди акции promoId in [872,873]', schema)).toMatchObject({ operator: 'in', values: ['872', '873'] })
		const select = parseSelectHeaders('Иконка icon,Айди акции promoId', schema)
		if (typeof select === 'string') throw new Error(select)
		expect(select.map((header) => header.original)).toEqual(['Иконка icon', 'Айди акции promoId'])
	})
})
