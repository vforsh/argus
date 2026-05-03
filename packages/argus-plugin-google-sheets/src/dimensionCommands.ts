import type { Command } from 'commander'
import type { ArgusPluginContextV1 } from '@vforsh/argus-plugin-api'
import { buildDimensionMutationExpression, type SheetDimensionMutationResult } from './dimensionPageScripts.js'
import { buildSelectRangeExpression, type SheetSelectResult } from './pageScripts.js'

type Output = ReturnType<ArgusPluginContextV1['host']['createOutput']>

type Dimension = 'rows' | 'columns'
type InsertSide = 'before' | 'after'
type DimensionAction = 'add' | 'remove'

type DimensionOptions = {
	count?: string
	json?: boolean
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
	ok: true
	mutations: SheetDimensionMutationResult[]
}

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
	const mutations = await mutateDimension(ctx, id, output, input)
	if (!mutations) return

	writeDimensionResult(output, options, { ok: true, ...input, mutations })
}

const mutateDimension = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	output: Output,
	input: DimensionMutationInput,
): Promise<SheetDimensionMutationResult[] | null> => {
	const mutations: SheetDimensionMutationResult[] = []
	for (let remaining = input.count; remaining > 0; remaining--) {
		const range = buildSingleDimensionRange(input.dimension, input.index)
		const selected = await selectRange(ctx, id, range, output)
		if (!selected) return null

		const result = await evalInWatcher<SheetDimensionMutationResult>(
			ctx,
			id,
			buildDimensionMutationExpression({
				action: input.action,
				dimension: input.dimension,
				index: input.index,
				count: 1,
				side: input.side,
				range: selected.range,
			}),
			output,
		)
		if (!result) return null
		mutations.push(result)
	}
	return mutations
}

const selectRange = async (ctx: ArgusPluginContextV1, id: string | undefined, range: string, output: Output): Promise<SheetSelectResult | null> => {
	const result = await evalInWatcher<SheetSelectResult>(ctx, id, buildSelectRangeExpression(range), output)
	if (!result) return null

	const selected = await dispatchKey(ctx, id, output, { key: 'Enter', selector: '#t-name-box' })
	if (!selected) return null

	await sleep(200)
	return result
}

const buildSingleDimensionRange = (dimension: Dimension, index: number): string => {
	if (dimension === 'rows') return `${index}:${index}`
	const column = indexToColumnLetters(index)
	return `${column}:${column}`
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

const indexToColumnLetters = (index: number): string => {
	let value = index
	let letters = ''
	while (value > 0) {
		const rem = (value - 1) % 26
		letters = String.fromCharCode(65 + rem) + letters
		value = Math.floor((value - 1) / 26)
	}
	return letters
}

const dispatchKey = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	output: Output,
	body: { key: string; selector?: string; modifiers?: string },
): Promise<boolean> => {
	const response = await ctx.host.argus.dom.keydown(id, body, {
		timeoutMs: 30_000,
	})
	if (response.ok) return true

	ctx.host.writeRequestError(response, output)
	process.exitCode = response.exitCode
	return false
}

const evalInWatcher = async <T>(ctx: ArgusPluginContextV1, id: string | undefined, expression: string, output: Output): Promise<T | null> => {
	const response = await ctx.host.argus.eval(
		id,
		{
			expression,
			awaitPromise: true,
			returnByValue: true,
			timeoutMs: 30_000,
		},
		{
			timeoutMs: 35_000,
		},
	)
	if (!response.ok) {
		ctx.host.writeRequestError(response, output)
		process.exitCode = response.exitCode
		return null
	}
	if (response.data.exception) {
		output.writeWarn(response.data.exception.text)
		process.exitCode = 1
		return null
	}
	return response.data.result as T
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
