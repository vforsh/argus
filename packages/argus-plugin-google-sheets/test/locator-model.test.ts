import { describe, expect, test } from 'bun:test'
import { advanceLocator, planLocatorProbes, retryDelaysMs } from '../src/locatorModel.js'

const probes = (input: Partial<Parameters<typeof planLocatorProbes>[0]>): number[] =>
	planLocatorProbes({ exportRow: 1, offset: 0, probed: 0, minRow: 1, maxRow: 100, batchSize: 10, ...input })

describe('monotone exact-row locator model', () => {
	test('predicts one row per candidate when no rows were dropped from the export', () => {
		expect(probes({ exportRow: 4, offset: 0, minRow: 2 })).toEqual([4])
		expect(probes({ exportRow: 5, offset: 0, minRow: 2 })).toEqual([5])
		expect(advanceLocator(0, 4, 4)).toBe(0)
	})

	test('widens in proportion to how wrong the prediction turned out to be', () => {
		expect(probes({ exportRow: 4, probed: 1, batchSize: 4 })).toEqual([5])
		expect(probes({ exportRow: 4, probed: 2, batchSize: 4 })).toEqual([6, 7])
		expect(probes({ exportRow: 4, probed: 4, batchSize: 4 })).toEqual([8, 9, 10, 11])
		expect(probes({ exportRow: 4, probed: 8, batchSize: 4 })).toEqual([12, 13, 14, 15])
	})

	test('costs two fetches when one blank row was dropped above the candidate', () => {
		expect(probes({ exportRow: 4, offset: 0, probed: 0, minRow: 2 })).toEqual([4])
		expect(probes({ exportRow: 4, offset: 0, probed: 1, minRow: 2 })).toEqual([5])
	})

	test('carries a grown offset forward so later candidates cost one probe again', () => {
		// Two blank rows above the match: the walk pays for them once, then predicts exactly.
		const offset = advanceLocator(0, 4, 6)
		expect(offset).toBe(2)
		expect(probes({ exportRow: 5, offset, minRow: 7 })).toEqual([7])
		expect(advanceLocator(offset, 5, 7)).toBe(2)
	})

	test('never lets the offset shrink or two candidates claim the same physical row', () => {
		expect(advanceLocator(3, 5, 5)).toBe(3)
		expect(probes({ exportRow: 4, offset: 0, minRow: 9 })).toEqual([9])
	})

	test('reports no probe at all once the walk would pass maxRow', () => {
		expect(probes({ exportRow: 100, offset: 5, maxRow: 100 })).toEqual([])
		expect(probes({ exportRow: 98, probed: 3, maxRow: 100, batchSize: 10 })).toEqual([])
	})

	test('caps a batch at maxRow instead of probing past it', () => {
		expect(probes({ exportRow: 95, offset: 0, probed: 4, maxRow: 100, batchSize: 10 })).toEqual([99, 100])
	})

	test('retries throttled gviz reads three times, then gives up', () => {
		expect([0, 1, 2, 3].map(retryDelaysMs)).toEqual([250, 500, 1_000, null])
		expect(retryDelaysMs(-1)).toBeNull()
	})
})
