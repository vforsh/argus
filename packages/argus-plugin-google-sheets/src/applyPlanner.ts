import { expandA1RangeForShape, formatA1Cell, indexToColumnLetters, parseA1Cell } from './a1.js'
import { hashManifestSnapshot, type SheetManifest, type SheetManifestOperation } from './manifest.js'
import { findExportHeaderIndex, queryExportRows, type ExportRowCandidate } from './queryModel.js'
import { resolveHeader, type SheetSchema } from './schema.js'
import { compareTypedMatrix, type CellValue, type RawCellValue, type TypedMismatch } from './typedValues.js'

/** Concrete sheet target resolved during preflight. */
export type PlannedSheetTarget = { name: string; gid: string; url: string }

/** Browser-independent adapter required by the semantic preflight planner. */
export type ApplyPlannerAdapter = {
	resolveSheet: (sheet: string) => Promise<PlannedSheetTarget>
	readSchema: (target: PlannedSheetTarget, headerRow: number) => Promise<SheetSchema>
	readExport: (target: PlannedSheetTarget) => Promise<string[][]>
	locateRows: (target: PlannedSheetTarget, headerRow: number, width: number, candidates: ExportRowCandidate[]) => Promise<Map<number, number>>
	readRaw: (target: PlannedSheetTarget, range: string, rows: number, columns: number) => Promise<RawCellValue[][]>
}

/** One concrete, precondition-checked sequential mutation step. */
export type PlannedApplyStep = {
	operationIndex: number
	op: 'setRange' | 'clear' | 'insertRows' | 'deleteRows'
	target: PlannedSheetTarget
	range: string
	before: CellValue[][]
	after: CellValue[][]
	row?: number
	count?: number
	following?: { range: string; before: RawCellValue[][] }
	source: SheetManifestOperation
}

/** Fully preflighted plan; no mutation may start before this exists. */
export type ApplyPlan = {
	version: 1
	steps: PlannedApplyStep[]
	snapshot: { algorithm: 'sha256'; value: string }
}

/** Preflight every semantic operation, exact location, and old-value expectation before any mutation. */
export const planSheetManifest = async (manifest: SheetManifest, adapter: ApplyPlannerAdapter): Promise<ApplyPlan> => {
	const targets = new Map<string, PlannedSheetTarget>()
	const targetFor = async (sheet: string): Promise<PlannedSheetTarget> => {
		const existing = targets.get(sheet)
		if (existing) return existing
		const target = await adapter.resolveSheet(sheet)
		targets.set(sheet, target)
		return target
	}
	const steps: PlannedApplyStep[] = []
	for (let index = 0; index < manifest.operations.length; index++) {
		const operation = manifest.operations[index]
		const target = await targetFor(operation.sheet)
		if (operation.op === 'setRange') {
			const range = expandA1RangeForShape(operation.range, operation.values.length, operation.values[0].length)
			await requireExpected(adapter, target, range, operation.expect, index)
			steps.push({ operationIndex: index, op: 'setRange', target, range, before: operation.expect, after: operation.values, source: operation })
		} else if (operation.op === 'setCells') {
			for (const a1 of sortA1Cells(Object.keys(operation.cells))) {
				const change = operation.cells[a1]
				await requireExpected(adapter, target, a1, [[change.expect]], index)
				steps.push({
					operationIndex: index,
					op: change.set === null ? 'clear' : 'setRange',
					target,
					range: a1,
					before: [[change.expect]],
					after: [[change.set]],
					source: operation,
				})
			}
		} else if (operation.op === 'clear') {
			const range = expandA1RangeForShape(operation.range, operation.expect.length, operation.expect[0].length)
			await requireExpected(adapter, target, range, operation.expect, index)
			steps.push({
				operationIndex: index,
				op: 'clear',
				target,
				range,
				before: operation.expect,
				after: nullMatrix(operation.expect.length, operation.expect[0].length),
				source: operation,
			})
		} else if (operation.op === 'updateByKey') {
			steps.push(...(await planUpdateByKey(adapter, target, operation, index)))
		} else if (operation.op === 'insertRowsAfter') {
			steps.push(await planInsertRows(adapter, target, operation, index))
		} else {
			const lastColumn = Math.max(0, operation.expect[0].length - 1)
			const range = `A${operation.row}:${indexToColumnLetters(lastColumn)}${operation.row + operation.count - 1}`
			await requireExpected(adapter, target, range, operation.expect, index)
			const followingRange = `A${operation.row + operation.count}:${indexToColumnLetters(lastColumn)}${operation.row + operation.count * 2 - 1}`
			const following = await adapter.readRaw(target, followingRange, operation.count, lastColumn + 1)
			steps.push({
				operationIndex: index,
				op: 'deleteRows',
				target,
				range,
				before: operation.expect,
				after: [],
				row: operation.row,
				count: operation.count,
				following: {
					range: `A${operation.row}:${indexToColumnLetters(lastColumn)}${operation.row + operation.count - 1}`,
					before: following,
				},
				source: operation,
			})
		}
	}
	rejectOverlappingWrites(steps)
	const snapshotValue = hashManifestSnapshot(
		steps.map((step) => ({
			operationIndex: step.operationIndex,
			op: step.op,
			sheet: step.target.name,
			gid: step.target.gid,
			range: step.range,
			before: step.before,
			after: step.after,
		})),
	)
	if (manifest.snapshot && manifest.snapshot.value !== snapshotValue)
		throw new Error(`Manifest snapshot is stale: expected ${manifest.snapshot.value}, current ${snapshotValue}.`)
	return { version: 1, steps, snapshot: { algorithm: 'sha256', value: snapshotValue } }
}

const planUpdateByKey = async (
	adapter: ApplyPlannerAdapter,
	target: PlannedSheetTarget,
	operation: Extract<SheetManifestOperation, { op: 'updateByKey' }>,
	operationIndex: number,
): Promise<PlannedApplyStep[]> => {
	const schema = await adapter.readSchema(target, operation.headerRow)
	const keyHeader = resolveHeader(schema, operation.keyColumn)
	if (typeof keyHeader === 'string') throw new Error(keyHeader)
	const valueHeader = resolveHeader(schema, operation.valueColumn)
	if (typeof valueHeader === 'string') throw new Error(valueHeader)
	const rows = await adapter.readExport(target)
	const headerIndex = findExportHeaderIndex(rows, schema)
	if (headerIndex < 0) throw new Error(`Physical header row ${operation.headerRow} was not found in export for ${target.name}.`)
	const requested = new Set(Object.keys(operation.changes))
	const candidates = queryExportRows(rows, headerIndex, { header: keyHeader, operator: 'in', values: [...requested] })
	const counts = new Map<string, number>()
	for (const candidate of candidates) {
		const key = candidate.values[keyHeader.index - 1] ?? ''
		counts.set(key, (counts.get(key) ?? 0) + 1)
	}
	for (const key of requested) {
		const count = counts.get(key) ?? 0
		if (count !== 1) throw new Error(`updateByKey requires exactly one row for key ${JSON.stringify(key)}; found ${count}.`)
	}
	const locations = await adapter.locateRows(target, operation.headerRow, schema.headers.length, candidates)
	const steps: PlannedApplyStep[] = []
	for (const candidate of candidates) {
		const sheetRow = locations.get(candidate.exportRow)
		if (!sheetRow) throw new Error(`Exact physical locator did not resolve export row ${candidate.exportRow}.`)
		const key = candidate.values[keyHeader.index - 1] ?? ''
		const change = operation.changes[key]
		const range = formatA1Cell(valueHeader.index - 1, sheetRow - 1)
		await requireExpected(adapter, target, range, [[change.expect]], operationIndex)
		steps.push({
			operationIndex,
			op: change.set === null ? 'clear' : 'setRange',
			target,
			range,
			before: [[change.expect]],
			after: [[change.set]],
			source: operation,
		})
	}
	return steps
}

const planInsertRows = async (
	adapter: ApplyPlannerAdapter,
	target: PlannedSheetTarget,
	operation: Extract<SheetManifestOperation, { op: 'insertRowsAfter' }>,
	operationIndex: number,
): Promise<PlannedApplyStep> => {
	if (operation.expectMatches !== 1) throw new Error('insertRowsAfter is safety-critical and currently requires expectMatches: 1.')
	const schema = await adapter.readSchema(target, operation.headerRow)
	const matchHeader = resolveHeader(schema, operation.match.column)
	if (typeof matchHeader === 'string') throw new Error(matchHeader)
	const rows = await adapter.readExport(target)
	const headerIndex = findExportHeaderIndex(rows, schema)
	if (headerIndex < 0) throw new Error(`Physical header row ${operation.headerRow} was not found in export for ${target.name}.`)
	const candidates = queryExportRows(rows, headerIndex, { header: matchHeader, operator: 'equals', value: operation.match.equals })
	if (candidates.length !== operation.expectMatches) {
		throw new Error(`insertRowsAfter expected ${operation.expectMatches} semantic match(es), found ${candidates.length}.`)
	}
	const locations = await adapter.locateRows(target, operation.headerRow, schema.headers.length, candidates)
	const anchorRow = locations.get(candidates[0].exportRow)
	if (!anchorRow) throw new Error('insertRowsAfter anchor could not be resolved to an exact physical row.')
	const row = anchorRow + 1
	const width = operation.rows[0].length
	const followingRange = `A${row}:${indexToColumnLetters(width - 1)}${row + operation.rows.length - 1}`
	const beforeRaw = await adapter.readRaw(target, followingRange, operation.rows.length, width)
	const before = rawToCellValues(beforeRaw)
	return {
		operationIndex,
		op: 'insertRows',
		target,
		range: followingRange,
		before,
		after: operation.rows,
		row,
		count: operation.rows.length,
		following: {
			range: `A${row + operation.rows.length}:${indexToColumnLetters(width - 1)}${row + operation.rows.length * 2 - 1}`,
			before: beforeRaw,
		},
		source: operation,
	}
}

const requireExpected = async (
	adapter: ApplyPlannerAdapter,
	target: PlannedSheetTarget,
	range: string,
	expected: CellValue[][],
	operationIndex: number,
): Promise<void> => {
	const actual = await adapter.readRaw(target, range, expected.length, expected[0].length)
	const mismatches = compareTypedMatrix(range, actual, expected)
	if (mismatches.length > 0) throw preconditionError(operationIndex, mismatches)
}

const preconditionError = (operationIndex: number, mismatches: TypedMismatch[]): Error => {
	const first = mismatches[0]
	return new Error(
		`Precondition failed before operation ${operationIndex} at ${first.a1}: expected ${JSON.stringify(first.expected)}, actual ${JSON.stringify(first.actual.value)} (${first.reason}).`,
	)
}

const rejectOverlappingWrites = (steps: PlannedApplyStep[]): void => {
	const occupied = new Map<string, PlannedApplyStep>()
	for (const step of steps) {
		if (step.op === 'insertRows' || step.op === 'deleteRows') continue
		const start = parseA1Cell(step.range.split(':')[0])
		if (!start) continue
		for (let row = 0; row < step.after.length; row++) {
			for (let column = 0; column < (step.after[row]?.length ?? 0); column++) {
				const key = `${step.target.gid}:${start.row + row}:${start.column + column}`
				const previous = occupied.get(key)
				if (previous)
					throw new Error(
						`Overlapping writes at ${a1ForStep(step, row, column)} in operations ${previous.operationIndex} and ${step.operationIndex}.`,
					)
				occupied.set(key, step)
			}
		}
	}
}

const a1ForStep = (step: PlannedApplyStep, row: number, column: number): string => {
	const start = parseA1Cell(step.range.split(':')[0]) as NonNullable<ReturnType<typeof parseA1Cell>>
	return formatA1Cell(start.column + column, start.row + row)
}
const sortA1Cells = (values: string[]): string[] =>
	[...values].sort((left, right) => {
		const a = parseA1Cell(left) as NonNullable<ReturnType<typeof parseA1Cell>>
		const b = parseA1Cell(right) as NonNullable<ReturnType<typeof parseA1Cell>>
		return a.row - b.row || a.column - b.column
	})
const nullMatrix = (rows: number, columns: number): CellValue[][] => Array.from({ length: rows }, () => Array<CellValue>(columns).fill(null))
const rawToCellValues = (rows: RawCellValue[][]): CellValue[][] =>
	rows.map((row) => row.map((cell) => (cell.formula ? { formula: cell.formula } : cell.value)))
