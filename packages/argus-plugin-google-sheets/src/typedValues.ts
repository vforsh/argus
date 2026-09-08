import { a1ForOffset } from './a1.js'

/** Explicit Google Sheets formula input. */
export type FormulaValue = { formula: string }

/** Supported declarative cell values. Null means native clear. */
export type CellValue = string | number | boolean | null | FormulaValue

/**
 * Raw cell representation returned by an exact cell-source read.
 *
 * `hasFormula` comes free with the rectangle copy; `formula` is the A1 source read from the formula
 * bar, which costs two extra round trips per cell and is therefore only resolved where a caller
 * actually compares against a formula. So `formula: null` means either "no formula" or "source not
 * read", and only `hasFormula` tells those apart -- never infer formula presence from `formula`.
 */
export type RawCellValue = {
	value: string | number | boolean | null
	formatted: string | null
	hasFormula: boolean
	formula: string | null
	error: string | null
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

/**
 * Compare an exact raw cell read with the requested typed value.
 *
 * A formula, an error, and a computed value are three different states, so a scalar expectation only
 * matches a plain scalar cell: a leftover `=15/10` never passes as the number 1.5, and `=""` never
 * passes as a clear.
 */
export const typedValueMatches = (actual: RawCellValue, expected: CellValue): boolean => {
	if (expected !== null && typeof expected === 'object') return actual.hasFormula && actual.formula === expected.formula
	if (actual.hasFormula || actual.error !== null) return false
	return scalarMatches(actual.value, expected)
}

/** Compare a structurally shifted raw cell while allowing Sheets to rewrite an A1 formula reference. */
export const shiftedRawValueMatches = (actual: RawCellValue, before: RawCellValue): boolean =>
	actual.hasFormula === before.hasFormula && actual.error === before.error && scalarMatches(actual.value, before.value)

/** Match a raw value against a scalar expectation, treating blank and empty text as the same clear. */
const scalarMatches = (actual: RawCellValue['value'], expected: string | number | boolean | null): boolean => {
	if (expected === null) return actual === null || actual === ''
	if (typeof expected !== 'number') return actual === expected
	if (typeof actual !== 'number') return false
	return Object.is(normalizeZero(actual), normalizeZero(expected))
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
			const actualValue = actual[row]?.[column] ?? blankRawValue()
			if (typedValueMatches(actualValue, expectedValue)) continue
			mismatches.push({
				a1: a1ForOffset(range, row, column),
				expected: expectedValue,
				actual: actualValue,
				reason: mismatchReason(actualValue, expectedValue),
			})
		}
	}
	return mismatches
}

/** A cell the read did not return at all; treated as blank rather than silently matching. */
export const blankRawValue = (): RawCellValue => ({ value: null, formatted: null, hasFormula: false, formula: null, error: null })

/** Convert a raw rectangle to manifest-ready cell values. Formula cells need a resolved source. */
export const rawToCellValues = (rows: readonly (readonly RawCellValue[])[], range: string): CellValue[][] =>
	rows.map((row, rowIndex) =>
		row.map((cell, columnIndex) => {
			if (!cell.hasFormula) return cell.value
			if (cell.formula === null)
				throw new Error(`Formula source at ${a1ForOffset(range, rowIndex, columnIndex)} was not read; cannot record it.`)
			return { formula: cell.formula }
		}),
	)

const mismatchReason = (actual: RawCellValue, expected: CellValue): string => {
	if (expected !== null && typeof expected === 'object' && actual.hasFormula && actual.formula === null) return 'formula source not read'
	return `expected ${cellValueType(expected)}, got ${rawValueType(actual)}`
}

const normalizeZero = (value: number): number => (Object.is(value, -0) ? 0 : value)
const rawValueType = (actual: RawCellValue): string => {
	if (actual.hasFormula) return 'formula'
	if (actual.error !== null) return 'error'
	return actual.value === null || actual.value === '' ? 'clear' : typeof actual.value
}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
