import { describe, expect, test } from 'bun:test'
import { planStructuralProbes } from '../src/structuralVerification.js'

describe('structural shift verification', () => {
	test('tracks an anchor and following row across a bulk insert', () => {
		expect(planStructuralProbes({ action: 'add', dimension: 'rows', index: 82, count: 3, side: 'after' }, 'A82')).toEqual([
			{ role: 'anchor', sourceA1: 'A82', destinationA1: 'A82' },
			{ role: 'following', sourceA1: 'A83', destinationA1: 'A86' },
		])
	})

	test('tracks the following row into a removed block', () => {
		expect(planStructuralProbes({ action: 'remove', dimension: 'rows', index: 83, count: 2 }, 'A82')).toEqual([
			{ role: 'anchor', sourceA1: 'A82', destinationA1: 'A82' },
			{ role: 'following', sourceA1: 'A85', destinationA1: 'A83' },
		])
	})

	test('supports column shifts and marks a removed anchor', () => {
		expect(planStructuralProbes({ action: 'remove', dimension: 'columns', index: 2, count: 2 }, 'C4')).toEqual([
			{ role: 'anchor', sourceA1: 'C4', destinationA1: null },
			{ role: 'following', sourceA1: 'D4', destinationA1: 'B4' },
		])
	})
})
