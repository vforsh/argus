import { createHash } from 'node:crypto'
import { parseA1Cell, parseA1Range } from './a1.js'
import { parseCellValue, type CellValue } from './typedValues.js'

/** Semantic row insertion operation. */
export type InsertRowsAfterOperation = {
	op: 'insertRowsAfter'
	sheet: string
	headerRow: number
	match: { column: string; equals: string }
	expectMatches: number
	rows: CellValue[][]
}

/** Sparse key-based update operation with mandatory old/new values. */
export type UpdateByKeyOperation = {
	op: 'updateByKey'
	sheet: string
	headerRow: number
	keyColumn: string
	valueColumn: string
	changes: Record<string, { expect: CellValue; set: CellValue }>
}

/** Dense typed range set with a mandatory expected old rectangle. */
export type SetRangeOperation = {
	op: 'setRange'
	sheet: string
	range: string
	expect: CellValue[][]
	values: CellValue[][]
}

/** Sparse typed set with mandatory per-cell old/new values. */
export type SetCellsOperation = {
	op: 'setCells'
	sheet: string
	cells: Record<string, { expect: CellValue; set: CellValue }>
}

/** Native clear with a mandatory expected old rectangle. */
export type ClearOperation = {
	op: 'clear'
	sheet: string
	range: string
	expect: CellValue[][]
}

/** Structural inverse emitted by apply journals. */
export type DeleteRowsOperation = {
	op: 'deleteRows'
	sheet: string
	row: number
	count: number
	expect: CellValue[][]
}

/** Supported version-1 declarative mutation operation. */
export type SheetManifestOperation =
	| InsertRowsAfterOperation
	| UpdateByKeyOperation
	| SetRangeOperation
	| SetCellsOperation
	| ClearOperation
	| DeleteRowsOperation

/** Versioned, sequential, explicitly non-transactional mutation manifest. */
export type SheetManifest = {
	version: 1
	snapshot?: { algorithm: 'sha256'; value: string }
	operations: SheetManifestOperation[]
}

/** Parse and strictly validate a version-1 mutation manifest. */
export const parseSheetManifest = (value: unknown): SheetManifest | string => {
	if (!isRecord(value)) return 'Manifest must be an object.'
	const topError = rejectUnknownKeys(value, ['version', 'snapshot', 'operations'], 'manifest')
	if (topError) return topError
	if (value.version !== 1) return 'Manifest version must be 1.'
	if (!Array.isArray(value.operations) || value.operations.length === 0) return 'Manifest operations must be a non-empty array.'
	let snapshot: SheetManifest['snapshot']
	if (value.snapshot != null) {
		if (
			!isRecord(value.snapshot) ||
			value.snapshot.algorithm !== 'sha256' ||
			typeof value.snapshot.value !== 'string' ||
			!/^[a-f0-9]{64}$/i.test(value.snapshot.value)
		) {
			return 'Manifest snapshot must be {"algorithm":"sha256","value":"<64 hex chars>"}.'
		}
		snapshot = { algorithm: 'sha256', value: value.snapshot.value.toLowerCase() }
	}
	const operations: SheetManifestOperation[] = []
	for (let index = 0; index < value.operations.length; index++) {
		const operation = parseOperation(value.operations[index], index)
		if (typeof operation === 'string') return operation
		operations.push(operation)
	}
	return { version: 1, snapshot, operations }
}

/** Hash a deterministic preflight snapshot for stale-state rejection. */
export const hashManifestSnapshot = (value: unknown): string => createHash('sha256').update(stableStringify(value)).digest('hex')

/** Deterministically stringify JSON-like values with sorted object keys. */
export const stableStringify = (value: unknown): string => JSON.stringify(sortValue(value))

const parseOperation = (value: unknown, index: number): SheetManifestOperation | string => {
	const path = `operations[${index}]`
	if (!isRecord(value) || typeof value.op !== 'string') return `${path} must be an object with an op.`
	if (value.op === 'insertRowsAfter') return parseInsertRows(value, path)
	if (value.op === 'updateByKey') return parseUpdateByKey(value, path)
	if (value.op === 'setRange') return parseSetRange(value, path)
	if (value.op === 'setCells') return parseSetCells(value, path)
	if (value.op === 'clear') return parseClear(value, path)
	if (value.op === 'deleteRows') return parseDeleteRows(value, path)
	return `${path}.op is unsupported: ${String(value.op)}.`
}

const parseInsertRows = (value: Record<string, unknown>, path: string): InsertRowsAfterOperation | string => {
	const unknown = rejectUnknownKeys(value, ['op', 'sheet', 'headerRow', 'match', 'expectMatches', 'rows'], path)
	if (unknown) return unknown
	const sheet = parseSheet(value.sheet, `${path}.sheet`)
	if (typeof sheet !== 'string' || sheet === '') return sheet
	const headerRow = parsePositiveInteger(value.headerRow ?? 1, `${path}.headerRow`)
	if (typeof headerRow === 'string') return headerRow
	if (!isRecord(value.match) || typeof value.match.column !== 'string' || !value.match.column.trim() || typeof value.match.equals !== 'string') {
		return `${path}.match must contain non-empty column and string equals fields.`
	}
	const expectMatches = parsePositiveInteger(value.expectMatches, `${path}.expectMatches`)
	if (typeof expectMatches === 'string') return expectMatches
	const rows = parseMatrix(value.rows, `${path}.rows`)
	if (typeof rows === 'string') return rows
	return { op: 'insertRowsAfter', sheet, headerRow, match: { column: value.match.column, equals: value.match.equals }, expectMatches, rows }
}

const parseUpdateByKey = (value: Record<string, unknown>, path: string): UpdateByKeyOperation | string => {
	const unknown = rejectUnknownKeys(value, ['op', 'sheet', 'headerRow', 'keyColumn', 'valueColumn', 'changes'], path)
	if (unknown) return unknown
	const sheet = parseSheet(value.sheet, `${path}.sheet`)
	if (typeof sheet !== 'string' || sheet === '') return sheet
	const headerRow = parsePositiveInteger(value.headerRow ?? 1, `${path}.headerRow`)
	if (typeof headerRow === 'string') return headerRow
	if (typeof value.keyColumn !== 'string' || !value.keyColumn.trim()) return `${path}.keyColumn must be a non-empty string.`
	if (typeof value.valueColumn !== 'string' || !value.valueColumn.trim()) return `${path}.valueColumn must be a non-empty string.`
	if (!isRecord(value.changes) || Object.keys(value.changes).length === 0) return `${path}.changes must be a non-empty object.`
	const changes: UpdateByKeyOperation['changes'] = {}
	for (const [key, change] of Object.entries(value.changes)) {
		if (!key) return `${path}.changes contains an empty key.`
		if (!isRecord(change) || !Object.hasOwn(change, 'expect') || !Object.hasOwn(change, 'set'))
			return `${path}.changes[${JSON.stringify(key)}] needs expect and set.`
		const expect = parseCellValue(change.expect, `${path}.changes[${JSON.stringify(key)}].expect`)
		if (expect instanceof Error) return expect.message
		const set = parseCellValue(change.set, `${path}.changes[${JSON.stringify(key)}].set`)
		if (set instanceof Error) return set.message
		changes[key] = { expect, set }
	}
	return { op: 'updateByKey', sheet, headerRow, keyColumn: value.keyColumn, valueColumn: value.valueColumn, changes }
}

const parseSetRange = (value: Record<string, unknown>, path: string): SetRangeOperation | string => {
	const unknown = rejectUnknownKeys(value, ['op', 'sheet', 'range', 'expect', 'values'], path)
	if (unknown) return unknown
	const common = parseRangeCommon(value, path)
	if (typeof common === 'string') return common
	const expect = parseMatrix(value.expect, `${path}.expect`)
	if (typeof expect === 'string') return expect
	const values = parseMatrix(value.values, `${path}.values`)
	if (typeof values === 'string') return values
	if (expect.length !== values.length || expect[0].length !== values[0].length)
		return `${path}.expect and values must have the same rectangular shape.`
	return { op: 'setRange', ...common, expect, values }
}

const parseSetCells = (value: Record<string, unknown>, path: string): SetCellsOperation | string => {
	const unknown = rejectUnknownKeys(value, ['op', 'sheet', 'cells'], path)
	if (unknown) return unknown
	const sheet = parseSheet(value.sheet, `${path}.sheet`)
	if (typeof sheet !== 'string' || sheet === '') return sheet
	if (!isRecord(value.cells) || Object.keys(value.cells).length === 0) return `${path}.cells must be a non-empty object.`
	const cells: SetCellsOperation['cells'] = {}
	for (const [a1, change] of Object.entries(value.cells)) {
		if (!parseA1Cell(a1)) return `${path}.cells key ${JSON.stringify(a1)} must be an unqualified A1 cell.`
		if (!isRecord(change) || !Object.hasOwn(change, 'expect') || !Object.hasOwn(change, 'set'))
			return `${path}.cells[${JSON.stringify(a1)}] needs expect and set.`
		const expect = parseCellValue(change.expect, `${path}.cells[${JSON.stringify(a1)}].expect`)
		if (expect instanceof Error) return expect.message
		const set = parseCellValue(change.set, `${path}.cells[${JSON.stringify(a1)}].set`)
		if (set instanceof Error) return set.message
		cells[a1.toUpperCase()] = { expect, set }
	}
	return { op: 'setCells', sheet, cells }
}

const parseClear = (value: Record<string, unknown>, path: string): ClearOperation | string => {
	const unknown = rejectUnknownKeys(value, ['op', 'sheet', 'range', 'expect'], path)
	if (unknown) return unknown
	const common = parseRangeCommon(value, path)
	if (typeof common === 'string') return common
	const expect = parseMatrix(value.expect, `${path}.expect`)
	return typeof expect === 'string' ? expect : { op: 'clear', ...common, expect }
}

const parseDeleteRows = (value: Record<string, unknown>, path: string): DeleteRowsOperation | string => {
	const unknown = rejectUnknownKeys(value, ['op', 'sheet', 'row', 'count', 'expect'], path)
	if (unknown) return unknown
	const sheet = parseSheet(value.sheet, `${path}.sheet`)
	if (typeof sheet !== 'string' || sheet === '') return sheet
	const row = parsePositiveInteger(value.row, `${path}.row`)
	if (typeof row === 'string') return row
	const count = parsePositiveInteger(value.count, `${path}.count`)
	if (typeof count === 'string') return count
	const expect = parseMatrix(value.expect, `${path}.expect`)
	return typeof expect === 'string' ? expect : { op: 'deleteRows', sheet, row, count, expect }
}

const parseRangeCommon = (value: Record<string, unknown>, path: string): { sheet: string; range: string } | string => {
	const sheet = parseSheet(value.sheet, `${path}.sheet`)
	if (typeof sheet !== 'string' || sheet === '') return sheet
	if (typeof value.range !== 'string' || !parseA1Range(value.range)) return `${path}.range must be a valid A1 cell range.`
	if (parseA1Range(value.range)?.sheet) return `${path}.range must not contain a sheet qualifier; use the sheet field.`
	return { sheet, range: value.range.toUpperCase() }
}

const parseMatrix = (value: unknown, path: string): CellValue[][] | string => {
	if (!Array.isArray(value) || value.length === 0 || !Array.isArray(value[0]) || value[0].length === 0)
		return `${path} must be a non-empty rectangular matrix.`
	const width = value[0].length
	const rows: CellValue[][] = []
	for (let row = 0; row < value.length; row++) {
		if (!Array.isArray(value[row]) || value[row].length !== width) return `${path}[${row}] must contain exactly ${width} cells.`
		const cells: CellValue[] = []
		for (let column = 0; column < width; column++) {
			const parsed = parseCellValue(value[row][column], `${path}[${row}][${column}]`)
			if (parsed instanceof Error) return parsed.message
			cells.push(parsed)
		}
		rows.push(cells)
	}
	return rows
}

const parseSheet = (value: unknown, path: string): string =>
	typeof value === 'string' && value.trim() ? value.trim() : `${path} must be a non-empty string.`
const parsePositiveInteger = (value: unknown, path: string): number | string =>
	Number.isInteger(value) && Number(value) > 0 ? Number(value) : `${path} must be a positive integer.`
const rejectUnknownKeys = (value: Record<string, unknown>, allowed: string[], path: string): string | null => {
	const unknown = Object.keys(value).find((key) => !allowed.includes(key))
	return unknown ? `${path} contains unknown field ${JSON.stringify(unknown)}.` : null
}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const sortValue = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(sortValue)
	if (!isRecord(value)) return value
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, sortValue(value[key])]),
	)
}
