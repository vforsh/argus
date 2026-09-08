import type { ArgusPluginContextV1 } from '@vforsh/argus-plugin-api'
import { parseA1Range } from './a1.js'
import { usageError } from './cliArgs.js'
import { formatTable } from './commandFormatting.js'
import { readTypedMatrix } from './rawCellValues.js'
import { runSheetCommand, switchSheetTarget, type Output, withSheetLease } from './sheetCommandUtils.js'
import { rawToCellValues, type CellValue, type RawCellValue } from './typedValues.js'

/** Flags accepted by `sheets read`/`sheets export`; `--typed` switches to the raw rectangle path. */
export type TypedReadOptions = {
	json?: boolean
	gid?: string
	sheet?: string
	range?: string
	format?: string
	typed?: boolean
}

type TypedReadPlan = { range: string; rows: number; columns: number }

type TypedReadResult = {
	ok: true
	targetSheet: string | null
	targetGid: string | null
	targetUrl: string | null
	browserRestoredUrl: string | null
	range: string
	rows: number
	columns: number
	cells: RawCellValue[][]
	values: CellValue[][]
}

/**
 * Read one rectangle as raw typed cells instead of the CSV export.
 *
 * The CSV export is locale-formatted and type-blind; this path returns what the cells actually hold
 * — number vs text vs boolean, error labels, and formula sources. It costs three watcher round trips
 * plus two per formula cell, and it never touches CSV, so `--format csv|tsv` is refused rather than
 * silently answered from a different source.
 */
export const runTypedRead = (ctx: ArgusPluginContextV1, id: string | undefined, options: TypedReadOptions): Promise<void> =>
	runSheetCommand(ctx, id, options, {
		validate: (opts, output): TypedReadPlan | null => {
			if (opts.gid && opts.sheet) return usageError(output, 'Use only one sheet target: --gid or --sheet')
			if (!opts.range) return usageError(output, '--typed requires --range; a whole-sheet export cannot preserve geometry')
			const bounds = parseA1Range(opts.range)
			if (!bounds) return usageError(output, `--typed requires a physical A1 cell range, got ${opts.range}`)
			if (opts.format === 'csv' || opts.format === 'tsv')
				return usageError(output, '--typed never reads CSV; use --json or --format json/table')
			return {
				range: opts.range,
				rows: bounds.endRow - bounds.startRow + 1,
				columns: bounds.endColumn - bounds.startColumn + 1,
			}
		},
		execute: async ({ output, validated: plan }) => await readTyped(ctx, id, output, options, plan),
		formatHuman: (result, output, opts) => {
			if (opts.format === 'json') return output.writeJson(result)
			output.writeHuman(formatTable(result.cells.map((row) => row.map((cell) => cell.formatted ?? ''))))
		},
	})

const readTyped = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	output: Output,
	options: TypedReadOptions,
	plan: TypedReadPlan,
): Promise<TypedReadResult | null> => {
	const target = options.sheet ?? options.gid
	const leased = await withSheetLease(ctx, id, output, { operation: `read --typed ${plan.range}`, restore: true }, async () => {
		const switched = target ? await switchSheetTarget(ctx, id, target, output) : null
		if (target && !switched) return null
		return {
			switched,
			cells: await readTypedMatrix(ctx, id, output, { ...plan, resolveFormulaSources: 'all' }),
		}
	})
	const value = leased?.value
	if (!value?.cells) return null
	return {
		ok: true,
		targetSheet: value.switched?.sheet.name ?? null,
		targetGid: value.switched?.sheet.gid ?? null,
		targetUrl: value.switched?.url ?? null,
		browserRestoredUrl: leased?.release?.browserCurrentUrl ?? null,
		range: plan.range,
		rows: plan.rows,
		columns: plan.columns,
		cells: value.cells,
		values: rawToCellValues(value.cells, plan.range),
	}
}
