import type { Command } from 'commander'
import type { ArgusPluginContextV1 } from '@vforsh/argus-plugin-api'
import { indexToColumnLetters, parseA1Cell } from './a1.js'
import { parseCsv } from './csv.js'
import { buildDimensionMutationExpression, type SheetDimensionMutationResult } from './dimensionPageScripts.js'
import { buildReadCsvExpression, type SheetCsvResult } from './sheetDataPageScripts.js'
import { evalInWatcher, type Output, selectRange, switchSheetTarget, withSheetLease } from './sheetCommandUtils.js'
import { planStructuralProbes, type StructuralProbe } from './structuralVerification.js'

type Dimension = 'rows' | 'columns'
type InsertSide = 'before' | 'after'
type DimensionAction = 'add' | 'remove'

type DimensionOptions = {
	count?: string
	json?: boolean
	sheet?: string
	expectCell?: string
}

type DimensionAddOptions = DimensionOptions & {
	before?: boolean
	after?: boolean
}

type DimensionRemoveOptions = DimensionOptions & {
	force?: boolean
}

type DimensionRequest = {
	index: number
	count: number
}

type DimensionMutationInput = DimensionRequest & {
	action: DimensionAction
	dimension: Dimension
	side?: InsertSide
}

type DimensionCommandResult = DimensionMutationInput & {
	ok: boolean
	mutations: SheetDimensionMutationResult[]
	verified: boolean
	checks: StructuralCheck[]
}

type StructuralCheck = StructuralProbe & { expected: string; actual: string | null; verified: boolean }

export const registerSheetDimensionCommands = (ctx: ArgusPluginContextV1, sheets: Command): void => {
	registerDimensionGroup(ctx, sheets, 'rows', 'row')
	registerDimensionGroup(ctx, sheets, 'columns', 'column')
}

const registerDimensionGroup = (ctx: ArgusPluginContextV1, sheets: Command, dimension: Dimension, singular: string): void => {
	const group = sheets.command(dimension).description(`Add or remove ${dimension} in the active sheet`)

	group
		.command('add')
		.argument('[id]', 'Watcher id for an attached Google Sheets tab')
		.argument('<index>', `1-based ${singular} index`)
		.description(`Insert ${dimension} in the active sheet`)
		.option('--count <n>', `Number of ${dimension} to insert (default: 1)`)
		.option('--before', `Insert before the target ${singular}`)
		.option('--after', `Insert after the target ${singular}`)
		.option('--sheet <nameOrGidOrIndex>', 'Target sheet name, 1-based index, or gid')
		.option('--expect-cell <a1=value>', 'Require an exact cell value before structural mutation')
		.option('--json', 'Output JSON for automation')
		.action(async (id: string | undefined, index: string, options: DimensionAddOptions) => runAddDimension(ctx, id, dimension, index, options))

	group
		.command('remove')
		.alias('delete')
		.argument('[id]', 'Watcher id for an attached Google Sheets tab')
		.argument('<index>', `1-based ${singular} index`)
		.description(`Remove ${dimension} from the active sheet`)
		.option('--count <n>', `Number of ${dimension} to remove (default: 1)`)
		.option('--force', `Actually remove the ${dimension}`)
		.option('--sheet <nameOrGidOrIndex>', 'Target sheet name, 1-based index, or gid')
		.option('--expect-cell <a1=value>', 'Require an exact cell value before structural mutation')
		.option('--json', 'Output JSON for automation')
		.action(async (id: string | undefined, index: string, options: DimensionRemoveOptions) =>
			runRemoveDimension(ctx, id, dimension, index, options),
		)
}

const runAddDimension = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	dimension: Dimension,
	indexValue: string,
	options: DimensionAddOptions,
): Promise<void> => {
	const output = ctx.host.createOutput(options)
	const request = parseDimensionRequest(dimension, indexValue, options.count, output)
	if (!request) return

	const side = parseInsertSide(options, output)
	if (!side) return

	await runDimensionMutation(ctx, id, output, options, {
		action: 'add',
		dimension,
		index: request.index,
		count: request.count,
		side,
	})
}

const runRemoveDimension = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	dimension: Dimension,
	indexValue: string,
	options: DimensionRemoveOptions,
): Promise<void> => {
	const output = ctx.host.createOutput(options)
	if (!options.force) {
		output.writeWarn(`Refusing to remove ${dimension} without --force`)
		process.exitCode = 2
		return
	}

	const request = parseDimensionRequest(dimension, indexValue, options.count, output)
	if (!request) return

	await runDimensionMutation(ctx, id, output, options, {
		action: 'remove',
		dimension,
		index: request.index,
		count: request.count,
	})
}

const runDimensionMutation = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	output: Output,
	options: DimensionOptions,
	input: DimensionMutationInput,
): Promise<void> => {
	const leased = await withSheetLease(ctx, id, output, { operation: `${input.action} ${input.dimension}`, restore: true }, async () => {
		if (options.sheet && !(await switchSheetTarget(ctx, id, options.sheet, output))) return null
		const expectation = options.expectCell ? parseExpectedCell(options.expectCell, output) : null
		if (options.expectCell && !expectation) return null
		const checks = expectation ? await captureStructuralChecks(ctx, id, output, input, expectation) : []
		if (!checks) return null
		const mutation = await mutateDimensionOnce(ctx, id, output, input)
		if (!mutation) return null
		const verifiedChecks = await verifyStructuralChecks(ctx, id, output, checks)
		return { mutation, checks: verifiedChecks }
	})
	const result = leased?.value
	if (!result) return
	const verified = result.checks.every((check) => check.verified)
	if (!verified) process.exitCode = 1

	writeDimensionResult(output, options, { ok: verified, ...input, mutations: [result.mutation], verified, checks: result.checks })
}

/** Execute one bulk row/column UI mutation after the caller acquires a sheet operation lease. */
export const mutateDimensionOnce = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	output: Output,
	input: DimensionMutationInput,
): Promise<SheetDimensionMutationResult | null> => {
	const selection = buildDimensionSelection(input)
	const selected = await selectRange(ctx, id, selection.range, output)
	if (!selected) return null
	return await evalInWatcher<SheetDimensionMutationResult>(
		ctx,
		id,
		buildDimensionMutationExpression({
			action: input.action,
			dimension: input.dimension,
			index: input.index,
			count: input.count,
			side: selection.menuSide,
			range: selected.range,
		}),
		output,
	)
}

const buildDimensionSelection = (input: DimensionMutationInput): { range: string; menuSide?: InsertSide } => {
	const start = input.action === 'add' && input.side === 'after' ? input.index + 1 : input.index
	const end = start + input.count - 1
	const range = input.dimension === 'rows' ? `${start}:${end}` : `${indexToColumnLetters(start - 1)}:${indexToColumnLetters(end - 1)}`
	return { range, menuSide: input.action === 'add' ? 'before' : undefined }
}

const parseExpectedCell = (expectation: string, output: Output): { a1: string; value: string } | null => {
	const separator = expectation.indexOf('=')
	if (separator <= 0) {
		output.writeWarn('--expect-cell must use A1=value syntax')
		process.exitCode = 2
		return null
	}
	const a1 = expectation.slice(0, separator).trim()
	const cell = parseA1Cell(a1)
	if (!cell || cell.sheet) {
		output.writeWarn(`Structural expectation must use an unqualified A1 cell, got ${a1}.`)
		process.exitCode = 2
		return null
	}
	return { a1: a1.toUpperCase(), value: expectation.slice(separator + 1) }
}

const captureStructuralChecks = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	output: Output,
	input: DimensionMutationInput,
	expectation: { a1: string; value: string },
): Promise<StructuralCheck[] | null> => {
	const probes = planStructuralProbes(input, expectation.a1)
	const checks: StructuralCheck[] = []
	for (const probe of probes) {
		const expected = await readCell(ctx, id, output, probe.sourceA1)
		if (expected == null) return null
		if (probe.role === 'anchor' && expected !== expectation.value) {
			output.writeWarn(
				`Structural precondition failed at ${probe.sourceA1}: expected ${JSON.stringify(expectation.value)}, actual ${JSON.stringify(expected)}`,
			)
			process.exitCode = 1
			return null
		}
		checks.push({ ...probe, expected, actual: null, verified: probe.destinationA1 == null })
	}
	return checks
}

const verifyStructuralChecks = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	output: Output,
	checks: StructuralCheck[],
): Promise<StructuralCheck[]> => {
	const deadline = Date.now() + 2_000
	let verified = checks
	do {
		verified = []
		for (const check of checks) {
			if (!check.destinationA1) {
				verified.push(check)
				continue
			}
			const actual = await readCell(ctx, id, output, check.destinationA1)
			verified.push({ ...check, actual, verified: actual === check.expected })
		}
		if (verified.every((check) => check.verified)) return verified
	} while (Date.now() < deadline)
	const first = verified.find((check) => !check.verified)
	if (first)
		output.writeWarn(
			`Structural verification failed: ${first.sourceA1} did not shift to ${first.destinationA1}; expected ${JSON.stringify(first.expected)}, actual ${JSON.stringify(first.actual)}`,
		)
	return verified
}

const readCell = async (ctx: ArgusPluginContextV1, id: string | undefined, output: Output, a1: string): Promise<string | null> => {
	const result = await evalInWatcher<SheetCsvResult>(ctx, id, buildReadCsvExpression({ range: a1 }), output)
	return result ? (parseCsv(result.csv)[0]?.[0] ?? '') : null
}

const parseDimensionRequest = (dimension: Dimension, indexValue: string, countValue: string | undefined, output: Output): DimensionRequest | null => {
	const index = parsePositiveInt(indexValue)
	if (index == null) {
		output.writeWarn(`${dimension === 'rows' ? 'Row' : 'Column'} index must be a positive integer`)
		process.exitCode = 2
		return null
	}

	const count = parsePositiveInt(countValue ?? '1')
	if (count == null) {
		output.writeWarn('--count must be a positive integer')
		process.exitCode = 2
		return null
	}

	return { index, count }
}

const parseInsertSide = (options: DimensionAddOptions, output: Output): InsertSide | null => {
	const sides = [options.before === true, options.after === true].filter(Boolean).length
	if (sides !== 1) {
		output.writeWarn('Choose exactly one insert side: --before or --after')
		process.exitCode = 2
		return null
	}
	return options.before ? 'before' : 'after'
}

const parsePositiveInt = (value: string): number | null => {
	const parsed = Number(value)
	return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

const writeDimensionResult = (output: Output, options: DimensionOptions, result: DimensionCommandResult): void => {
	if (options.json) {
		output.writeJson(result)
		return
	}

	const verb = result.action === 'add' ? 'Inserted' : 'Removed'
	const side = result.side ? ` ${result.side}` : ''
	output.writeHuman(`${verb} ${result.count} ${result.dimension} at #${result.index}${side}`)
}
