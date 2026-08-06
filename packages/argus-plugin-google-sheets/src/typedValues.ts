import { a1ForOffset } from './a1.js'

/** Explicit Google Sheets formula input. */
export type FormulaValue = { formula: string }

/** Supported declarative cell values. Null means native clear. */
export type CellValue = string | number | boolean | null | FormulaValue

/** Raw cell representation returned by an exact cell-source read. */
export type RawCellValue = {
	value: string | number | boolean | null
	formatted: string | null
	formula?: string | null
}

/** Typed verification mismatch. */
export type TypedMismatch = {
	a1: string
	expected: CellValue
	actual: RawCellValue
	reason: string
}

/** Validate and normalize one declarative cell value. */
export const parseCellValue = (value: unknown, path: string): CellValue | Error => {
	if (value === null || typeof value === 'boolean') return value
	if (typeof value === 'number') return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : new Error(`${path} must be a finite number`)
	if (typeof value === 'string') return value === '' ? new Error(`${path} must not be empty; use null to clear`) : value
	if (!isRecord(value) || Object.keys(value).length !== 1 || typeof value.formula !== 'string' || !value.formula.startsWith('=')) {
		return new Error(`${path} must be text, a finite number, boolean, null, or {"formula":"=..."}`)
	}
	return { formula: value.formula }
}

/** Return the semantic type name of a declarative cell value. */
export const cellValueType = (value: CellValue): 'text' | 'number' | 'boolean' | 'clear' | 'formula' => {
	if (value === null) return 'clear'
	if (typeof value === 'string') return 'text'
	if (typeof value === 'number') return 'number'
	if (typeof value === 'boolean') return 'boolean'
	return 'formula'
}

/** Serialize a typed rectangle for Google Sheets UI paste without conflating formula and text. */
export const typedValuesToTsv = (values: readonly (readonly CellValue[])[]): string =>
	values
		.map((row) =>
			row
				.map((value) => {
					if (value === null) return ''
					if (typeof value === 'string') return `'${value.replace(/\r?\n/g, ' ')}`
					if (typeof value === 'object') return value.formula.replace(/\r?\n/g, ' ')
					return String(value)
				})
				.join('\t'),
		)
		.join('\n')

/** Compare an exact raw cell read with the requested typed value. */
export const typedValueMatches = (actual: RawCellValue, expected: CellValue): boolean => {
	if (expected === null) return actual.value === null || actual.value === ''
	if (typeof expected === 'object') return actual.formula === expected.formula
	if (typeof expected !== 'number') return actual.value === expected
	if (typeof actual.value !== 'number') return false
	return Object.is(normalizeZero(actual.value), normalizeZero(expected))
}

/** Compare a structurally shifted raw cell while allowing Sheets to rewrite an A1 formula reference. */
export const shiftedRawValueMatches = (actual: RawCellValue, before: RawCellValue): boolean => {
	const valueMatches = typedValueMatches(actual, before.value)
	const formulaPresenceMatches = before.formula ? typeof actual.formula === 'string' : !actual.formula
	return valueMatches && formulaPresenceMatches
}

/** Compare an exact raw rectangle and report deterministic A1 mismatches. */
export const compareTypedMatrix = (
	range: string,
	actual: readonly (readonly RawCellValue[])[],
	expected: readonly (readonly CellValue[])[],
): TypedMismatch[] => {
	const mismatches: TypedMismatch[] = []
	for (let row = 0; row < expected.length; row++) {
		for (let column = 0; column < (expected[row]?.length ?? 0); column++) {
			const expectedValue = expected[row][column]
			const actualValue = actual[row]?.[column] ?? { value: null, formatted: null }
			if (typedValueMatches(actualValue, expectedValue)) continue
			mismatches.push({
				a1: a1ForOffset(range, row, column),
				expected: expectedValue,
				actual: actualValue,
				reason: `expected ${cellValueType(expectedValue)}, got ${rawValueType(actualValue.value)}`,
			})
		}
	}
	return mismatches
}

const normalizeZero = (value: number): number => (Object.is(value, -0) ? 0 : value)
const rawValueType = (value: RawCellValue['value']): string => (value === null || value === '' ? 'clear' : typeof value)
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
