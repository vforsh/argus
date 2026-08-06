import { describe, expect, test } from 'bun:test'
import { planSheetManifest, type ApplyPlannerAdapter, type PlannedSheetTarget } from '../src/applyPlanner.js'
import type { SheetManifest } from '../src/manifest.js'
import { buildSheetSchema } from '../src/schema.js'
import type { RawCellValue } from '../src/typedValues.js'

const target: PlannedSheetTarget = { name: 'August', gid: '7', url: 'https://docs.google.com/sheets#gid=7' }

const raw = (values: unknown[][]): RawCellValue[][] =>
	values.map((row) => row.map((value) => ({ value: value as RawCellValue['value'], formatted: value == null ? null : String(value) })))

describe('apply preflight planner', () => {
	test('resolves semantic updateByKey to an exact physical cell', async () => {
		const adapter: ApplyPlannerAdapter = {
			resolveSheet: async () => target,
			readSchema: async () => buildSheetSchema(['id', 'icon'], 1),
			readExport: async () => [
				['id', 'icon'],
				['872', 'old'],
			],
			locateRows: async (_target, _header, _width, candidates) => new Map([[candidates[0].exportRow, 6]]),
			readRaw: async () => raw([['old']]),
			readFormula: async () => null,
		}
		const manifest: SheetManifest = {
			version: 1,
			operations: [
				{
					op: 'updateByKey',
					sheet: 'August',
					headerRow: 1,
					keyColumn: 'id',
					valueColumn: 'icon',
					changes: { '872': { expect: 'old', set: 'new' } },
				},
			],
		}
		const plan = await planSheetManifest(manifest, adapter)
		expect(plan.steps).toMatchObject([{ op: 'setRange', range: 'B6', before: [['old']], after: [['new']] }])
	})

	test('rejects stale preconditions before returning any executable plan', async () => {
		let reads = 0
		const adapter: ApplyPlannerAdapter = {
			resolveSheet: async () => target,
			readSchema: async () => buildSheetSchema(['id'], 1),
			readExport: async () => [['id']],
			locateRows: async () => new Map(),
			readRaw: async () => {
				reads++
				return raw([['actual']])
			},
			readFormula: async () => null,
		}
		const manifest: SheetManifest = {
			version: 1,
			operations: [{ op: 'setRange', sheet: 'August', range: 'A2', expect: [['stale']], values: [['new']] }],
		}
		expect(planSheetManifest(manifest, adapter)).rejects.toThrow('Precondition failed')
		expect(reads).toBe(1)
	})
})
