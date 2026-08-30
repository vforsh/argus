import { parsePositiveInt, usageError } from './cliArgs.js'
import { failCommand } from './commandExit.js'
import type { ArgusPluginContextV1 } from '@vforsh/argus-plugin-api'
import { parseA1Range } from './a1.js'
import { registerSheetApplyCommand } from './applyCommands.js'
import { formatSheetInfo, formatSheetLabel, formatSheetList, formatTable } from './commandFormatting.js'
import { parseCsv, toTsv } from './csv.js'
import { registerSheetDiffCommand } from './diffCommands.js'
import { registerSheetDimensionCommands } from './dimensionCommands.js'
import { registerSheetInspectionCommands } from './inspectionCommands.js'
import { findExportMatches, resolveFindColumn } from './findModel.js'
import { collectGidsStepped } from './gidTraversal.js'
import { buildLocateCellsExpression, type ExactCellMatch, type ExactLocatorResult } from './locatorPageScripts.js'
import { parseTimeoutMs, registerSheetMutationCommands } from './mutationCommands.js'
import { runSheetCommand } from './sheetCommandUtils.js'
import {
	buildAddSheetExpression,
	buildInfoSheetsExpression,
	buildListSheetsExpression,
	buildMoveSheetExpression,
	buildRenameSheetExpression,
	buildRemoveSheetExpression,
	buildSwitchSheetExpression,
	type SheetAddResult,
	type SheetCsvResult,
	type SheetInfoResult,
	type SheetListResult,
	type SheetMoveResult,
	type SheetRenameResult,
	type SheetRemoveResult,
	type SheetSwitchResult,
} from './pageScripts.js'
import { evalInWatcher, resolveSheetTarget, selectRange, type Output, withSheetLease } from './sheetCommandUtils.js'
import { readSheetCsv } from './sheetRead.js'

type CommonOptions = {
	json?: boolean
	gid?: string
	sheet?: string
}

type ListOptions = {
	json?: boolean
	withGid?: boolean
	force?: boolean
	deadline?: string
}

type InfoOptions = ListOptions

type RemoveOptions = {
	json?: boolean
	force?: boolean
}

type ReadOptions = CommonOptions & {
	range?: string
	format?: string
}

type FindOptions = CommonOptions & {
	range?: string
	column?: string
	ignoreCase?: boolean
	limit?: string
	maxRow?: string
	locateTimeout?: string
}

export const registerSheetCommands = (ctx: ArgusPluginContextV1): void => {
	const sheets = ctx.program.command('sheets').alias('gs').description('Read and change the open Google Sheets tab')

	sheets
		.command('list')
		.argument('[id]', 'Watcher id for an attached Google Sheets tab')
		.description('List visible sheets in the current Google Sheets document')
		.option('--with-gid', 'Collect gid for every visible sheet by briefly switching through the tab bar')
		.option('--force', 'Allow guarded full traversal when more than 100 tabs are visible')
		.option('--deadline <duration>', 'Internal traversal deadline below watcher timeout (default: 20s)', '20s')
		.option('--json', 'Output JSON for automation')
		.action(async (id: string | undefined, options: ListOptions) => runList(ctx, id, options))

	sheets
		.command('info')
		.argument('[id]', 'Watcher id for an attached Google Sheets tab')
		.description('Show metadata for the current Google Sheets document')
		.option('--with-gid', 'Collect gid for every visible sheet by briefly switching through the tab bar')
		.option('--force', 'Allow guarded full traversal when more than 100 tabs are visible')
		.option('--deadline <duration>', 'Internal traversal deadline below watcher timeout (default: 20s)', '20s')
		.option('--json', 'Output JSON for automation')
		.action(async (id: string | undefined, options: InfoOptions) => runInfo(ctx, id, options))

	sheets
		.command('resolve')
		.argument('[id]', 'Watcher id for an attached Google Sheets tab')
		.argument('<sheet>', 'Known visible sheet name (recommended), 1-based index, or gid')
		.description('Resolve one sheet target and restore the original browser tab')
		.option('--json', 'Output JSON for automation')
		.action(async (id: string | undefined, sheet: string, options: CommonOptions) => runResolve(ctx, id, sheet, options))

	sheets
		.command('switch')
		.argument('[id]', 'Watcher id for an attached Google Sheets tab')
		.argument('<sheet>', 'Visible sheet name, 1-based visible index, or gid')
		.description('Switch the open Google Sheets tab to a visible sheet')
		.option('--json', 'Output JSON for automation')
		.action(async (id: string | undefined, sheet: string, options: CommonOptions) => runSwitch(ctx, id, sheet, options))

	sheets
		.command('open')
		.argument('[id]', 'Watcher id for an attached Google Sheets tab')
		.argument('<sheet>', 'Visible sheet name, 1-based visible index, or gid')
		.description('Open a visible sheet in the current Google Sheets document')
		.option('--json', 'Output JSON for automation')
		.action(async (id: string | undefined, sheet: string, options: CommonOptions) => runSwitch(ctx, id, sheet, options))

	sheets
		.command('add')
		.alias('create')
		.argument('[id]', 'Watcher id for an attached Google Sheets tab')
		.description('Add a new sheet to the current Google Sheets document')
		.option('--json', 'Output JSON for automation')
		.action(async (id: string | undefined, options: CommonOptions) => runAdd(ctx, id, options))

	sheets
		.command('remove')
		.alias('delete')
		.argument('[id]', 'Watcher id for an attached Google Sheets tab')
		.argument('<sheet>', 'Visible sheet name, 1-based visible index, or gid')
		.description('Remove a visible sheet from the current Google Sheets document')
		.option('--force', 'Actually remove the sheet')
		.option('--json', 'Output JSON for automation')
		.action(async (id: string | undefined, sheet: string, options: RemoveOptions) => runRemove(ctx, id, sheet, options))

	sheets
		.command('rename')
		.argument('[id]', 'Watcher id for an attached Google Sheets tab')
		.argument('<sheet>', 'Visible sheet name, 1-based visible index, or gid')
		.argument('<name>', 'New sheet name')
		.description('Rename a visible sheet in the current Google Sheets document')
		.option('--json', 'Output JSON for automation')
		.action(async (id: string | undefined, sheet: string, name: string, options: CommonOptions) => runRename(ctx, id, sheet, name, options))

	sheets
		.command('move')
		.argument('[id]', 'Watcher id for an attached Google Sheets tab')
		.argument('<sheet>', 'Visible sheet name, 1-based visible index, or gid')
		.argument('<index>', 'Target 1-based visible sheet index')
		.description('Move a visible sheet to a visible index')
		.option('--json', 'Output JSON for automation')
		.action(async (id: string | undefined, sheet: string, index: string, options: CommonOptions) => runMove(ctx, id, sheet, index, options))

	sheets
		.command('read')
		.argument('[id]', 'Watcher id for an attached Google Sheets tab')
		.description('Read sheet content through the authenticated Google Sheets CSV export')
		.option('--range <a1>', 'A1 range to read (default: exported sheet)')
		.option('--gid <gid>', 'Sheet gid (default: current tab gid)')
		.option('--sheet <nameOrGidOrIndex>', 'Visible sheet name, 1-based index, or gid')
		.option('--format <type>', 'Output format: table, tsv, csv, json (default: table)')
		.option('--json', 'Output JSON for automation')
		.action(async (id: string | undefined, options: ReadOptions) => runRead(ctx, id, options))

	sheets
		.command('export')
		.argument('[id]', 'Watcher id for an attached Google Sheets tab')
		.description('Export sheet content as TSV, CSV, or JSON')
		.option('--range <a1>', 'A1 range to export')
		.option('--gid <gid>', 'Sheet gid (default: current tab gid)')
		.option('--sheet <nameOrGidOrIndex>', 'Visible sheet name, 1-based index, or gid')
		.option('--format <type>', 'Output format: tsv, csv, json (default: tsv)')
		.option('--json', 'Output JSON for automation')
		.action(async (id: string | undefined, options: ReadOptions) => runRead(ctx, id, { ...options, format: options.format ?? 'tsv' }))

	sheets
		.command('find')
		.argument('[id]', 'Watcher id for an attached Google Sheets tab')
		.argument('<text>', 'Text to find')
		.description('Find cells through export candidates plus exact physical-row verification')
		.option('--range <a1>', 'A1 range to search')
		.option('--gid <gid>', 'Sheet gid (default: current tab gid)')
		.option('--sheet <nameOrGidOrIndex>', 'Visible sheet name, 1-based index, or gid')
		.option('--column <nameOrIndex>', 'Search only one column (header name, A-style letter, or 1-based index)')
		.option('--ignore-case', 'Case-insensitive search')
		.option('--limit <n>', 'Maximum matches to print (default: 20)')
		.option('--max-row <n>', 'Maximum physical row scanned for exact coordinates (default: 5000)', '5000')
		.option('--locate-timeout <duration>', 'Internal exact locator deadline (default: 20s)', '20s')
		.option('--json', 'Output JSON for automation')
		.action(async (id: string | undefined, text: string, options: FindOptions) => runFind(ctx, id, text, options))

	sheets
		.command('select')
		.argument('[id]', 'Watcher id for an attached Google Sheets tab')
		.argument('<range>', 'A1 range to select')
		.description('Select a range in the open Google Sheets tab')
		.option('--json', 'Output JSON for automation')
		.action(async (id: string | undefined, range: string, options: CommonOptions) => runSelect(ctx, id, range, options))

	registerSheetMutationCommands(ctx, sheets)
	registerSheetDimensionCommands(ctx, sheets)
	registerSheetInspectionCommands(ctx, sheets)
	registerSheetDiffCommand(ctx, sheets)
	registerSheetApplyCommand(ctx, sheets)
}

const runList = (ctx: ArgusPluginContextV1, id: string | undefined, options: ListOptions): Promise<void> =>
	runSheetCommand(ctx, id, options, {
		validate: requireDeadline,
		execute: async ({ output, validated: deadlineMs }) => {
			const base = await evalInWatcher<SheetListResult>(ctx, id, buildListSheetsExpression({ withGid: false }), output)
			if (!base) return null
			return options.withGid ? await collectGidsStepped(ctx, id, output, base, options, Math.min(25_000, deadlineMs)) : base
		},
		formatHuman: (result, output) => output.writeHuman(formatSheetList(result.sheets)),
	})

const runInfo = (ctx: ArgusPluginContextV1, id: string | undefined, options: InfoOptions): Promise<void> =>
	runSheetCommand(ctx, id, options, {
		validate: requireDeadline,
		execute: async ({ output, validated: deadlineMs }) => {
			const base = await evalInWatcher<SheetInfoResult>(ctx, id, buildInfoSheetsExpression({ withGid: false }), output)
			if (!base) return null
			const list = options.withGid ? await collectGidsStepped(ctx, id, output, base, options, Math.min(25_000, deadlineMs)) : base
			if (!list) return null
			return { ...base, sheets: list.sheets, active: list.sheets.find((sheet) => sheet.active) ?? null } satisfies SheetInfoResult
		},
		formatHuman: (result, output) => output.writeHuman(formatSheetInfo(result)),
	})

/** Shared `--deadline` guard: three commands accept the same flag with the same message. */
const requireDeadline = (options: { deadline?: string }, output: Output): number | null =>
	parseTimeoutMs(options.deadline, 20_000) ?? usageError(output, '--deadline must be a positive duration such as 10s or 20s')

const runResolve = (ctx: ArgusPluginContextV1, id: string | undefined, sheet: string, options: CommonOptions): Promise<void> =>
	runSheetCommand(ctx, id, options, {
		execute: async ({ output }) => {
			const leased = await withSheetLease(
				ctx,
				id,
				output,
				{ operation: `resolve sheet ${sheet}`, restore: true },
				async () => await resolveSheetTarget(ctx, id, sheet, output),
			)
			const result = leased?.value
			if (!result) return null
			// The release reports where the browser actually landed, which beats the pre-restore guess.
			return {
				...result,
				sheet: { ...result.sheet, active: (leased.release?.browserCurrentGid ?? result.browser.restoredGid) === result.target.gid },
				browser: {
					...result.browser,
					restoredGid: leased.release?.browserCurrentGid ?? result.browser.restoredGid,
					restoredUrl: leased.release?.browserCurrentUrl ?? result.browser.restoredUrl,
				},
			}
		},
		formatHuman: (payload, output) => output.writeHuman(`${payload.target.name}\t${payload.target.gid}\t${payload.target.url}`),
	})

const runSwitch = (ctx: ArgusPluginContextV1, id: string | undefined, sheet: string, options: CommonOptions): Promise<void> =>
	runSheetCommand(ctx, id, options, {
		execute: ({ output }) => leasedEval<SheetSwitchResult>(ctx, id, output, `switch to sheet ${sheet}`, false, buildSwitchSheetExpression(sheet)),
		formatHuman: (result, output) => output.writeHuman(`Switched to ${formatSheetLabel(result.sheet)}`),
	})

const runAdd = (ctx: ArgusPluginContextV1, id: string | undefined, options: CommonOptions): Promise<void> =>
	runSheetCommand(ctx, id, options, {
		execute: ({ output }) => leasedEval<SheetAddResult>(ctx, id, output, 'add sheet', false, buildAddSheetExpression()),
		formatHuman: (result, output) => output.writeHuman(`Added ${formatSheetLabel(result.sheet)}`),
	})

const runRemove = (ctx: ArgusPluginContextV1, id: string | undefined, sheet: string, options: RemoveOptions): Promise<void> =>
	runSheetCommand(ctx, id, options, {
		validate: (opts, output) => (opts.force ? true : usageError(output, 'Refusing to remove a sheet without --force')),
		execute: ({ output }) => leasedEval<SheetRemoveResult>(ctx, id, output, `remove sheet ${sheet}`, false, buildRemoveSheetExpression(sheet)),
		formatHuman: (result, output) => output.writeHuman(`Removed ${formatSheetLabel(result.removed)}`),
	})

const runRename = (ctx: ArgusPluginContextV1, id: string | undefined, sheet: string, name: string, options: CommonOptions): Promise<void> =>
	runSheetCommand(ctx, id, options, {
		execute: ({ output }) =>
			leasedEval<SheetRenameResult>(ctx, id, output, `rename sheet ${sheet}`, false, buildRenameSheetExpression(sheet, name)),
		formatHuman: (result, output) => output.writeHuman(`Renamed ${formatSheetLabel(result.before)} to ${formatSheetLabel(result.sheet)}`),
	})

const runMove = (ctx: ArgusPluginContextV1, id: string | undefined, sheet: string, index: string, options: CommonOptions): Promise<void> =>
	runSheetCommand(ctx, id, options, {
		execute: ({ output }) => leasedEval<SheetMoveResult>(ctx, id, output, `move sheet ${sheet}`, false, buildMoveSheetExpression(sheet, index)),
		formatHuman: (result, output) => output.writeHuman(`Moved ${formatSheetLabel(result.sheet)} to #${result.sheet.index}`),
	})

const runRead = (ctx: ArgusPluginContextV1, id: string | undefined, options: ReadOptions): Promise<void> =>
	runSheetCommand(ctx, id, options, {
		execute: async ({ output }) => {
			const data = await readSheetCsv(ctx, id, options, output)
			return data ? { data, rows: parseCsv(data.csv) } : null
		},
		formatJson: ({ data, rows }) => ({ ...withoutCsv(data), rows }),
		formatHuman: ({ data, rows }, output, opts) => {
			// `--format json` prints the same payload without opting into the `--json` automation contract.
			if (opts.format === 'json') return output.writeJson({ ...withoutCsv(data), rows })
			if (opts.format === 'csv') return output.writeHuman(data.csv)
			if (opts.format === 'tsv') return output.writeHuman(toTsv(rows))
			return output.writeHuman(formatTable(rows))
		},
	})

/** Data-independent `find` flags, parsed once before the export round-trip. */
type FindPlan = {
	limit: number
	maxRow: number
	deadlineMs: number
	bounds: NonNullable<ReturnType<typeof parseA1Range>> | null
}

const runFind = (ctx: ArgusPluginContextV1, id: string | undefined, text: string, options: FindOptions): Promise<void> =>
	runSheetCommand(ctx, id, options, {
		validate: (opts, output): FindPlan | null => {
			const limit = parsePositiveInt(opts.limit, { fallback: 20 })
			if (limit == null) return usageError(output, '--limit must be a positive integer')

			const maxRow = parsePositiveInt(opts.maxRow, { fallback: 5_000 })
			if (maxRow == null) return usageError(output, '--max-row must be a positive integer')

			const deadlineMs = parseTimeoutMs(opts.locateTimeout, 20_000)
			if (deadlineMs == null) return usageError(output, '--locate-timeout must be a positive duration such as 5s or 20s')

			const bounds = opts.range ? parseA1Range(opts.range) : null
			if (opts.range && !bounds) return usageError(output, '--range must be a physical A1 cell range for coordinate-safe find')

			return { limit, maxRow, deadlineMs, bounds }
		},
		execute: async ({ output, validated }) => {
			const data = await readSheetCsv(ctx, id, options, output)
			if (!data) return null

			const rows = parseCsv(data.csv)
			// `--column` resolves against the header row, so it can only be checked once the export lands.
			const columnIndex = resolveFindColumn(options.column, rows[0] ?? [])
			if (columnIndex === false) return usageError(output, `Unknown --column: ${options.column}`)

			const ignoreCase = options.ignoreCase ?? false
			const needle = ignoreCase ? text.toLowerCase() : text
			const candidates = findExportMatches(rows, needle, { columnIndex, ignoreCase, limit: validated.limit })
			const { bounds } = validated
			const locator = await locateExactCells(ctx, id, output, {
				candidates,
				data,
				needle,
				columnIndex,
				ignoreCase,
				limit: validated.limit,
				deadlineMs: validated.deadlineMs,
				startRow: bounds ? bounds.startRow + 1 : 1,
				maxRow: bounds ? Math.min(validated.maxRow, bounds.endRow + 1) : validated.maxRow,
				firstColumn: bounds?.startColumn ?? 0,
				lastColumn: bounds?.endColumn ?? Math.max(0, ...rows.map((row) => row.length - 1)),
			})
			if (!locator) return null

			return { data, candidates, locator }
		},
		formatJson: ({ data, candidates, locator }) => ({
			...withoutCsv(data),
			query: text,
			candidateMatches: candidates,
			matches: locator.matches,
			locator: { complete: locator.complete, reason: locator.reason, scannedRows: locator.scannedRows },
		}),
		formatHuman: ({ locator }, output) => {
			for (const match of locator.matches) {
				output.writeHuman(`${match.a1}\t${match.value}`)
			}
			if (locator.matches.length === 0) output.writeHuman('No matches')
			if (!locator.complete) {
				output.writeWarn(`Exact locator incomplete (${locator.reason}); no export row was presented as a physical A1 coordinate.`)
			}
		},
	})

/**
 * Turn export-row candidates into physical A1 coordinates.
 *
 * Skips the browser round-trip entirely when the export found nothing. An incomplete scan is not a
 * hard failure -- the matches found so far are still printed -- but it records exit code 1 so a
 * script can tell a partial answer from a complete one.
 */
const locateExactCells = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	output: Output,
	input: {
		candidates: unknown[]
		data: { targetGid: string }
		needle: string
		columnIndex: number | null
		ignoreCase: boolean
		limit: number
		deadlineMs: number
		startRow: number
		maxRow: number
		firstColumn: number
		lastColumn: number
	},
): Promise<ExactLocatorResult<ExactCellMatch> | null> => {
	if (input.candidates.length === 0) {
		return { ok: true, matches: [], scannedRows: 0, complete: true, reason: 'found' }
	}

	const internalDeadline = Math.min(25_000, input.deadlineMs)
	const located = await evalInWatcher<ExactLocatorResult<ExactCellMatch>>(
		ctx,
		id,
		buildLocateCellsExpression({
			gid: input.data.targetGid,
			startRow: input.startRow,
			maxRow: input.maxRow,
			firstColumn: input.firstColumn,
			lastColumn: input.lastColumn,
			needle: input.needle,
			columnIndex: input.columnIndex,
			ignoreCase: input.ignoreCase,
			limit: input.limit,
			expectedMatches: input.candidates.length,
			deadlineMs: internalDeadline,
		}),
		output,
		{ evalTimeoutMs: internalDeadline + 2_000, requestTimeoutMs: internalDeadline + 5_000 },
	)
	if (!located) return null

	if (!located.complete) failCommand(1)
	return located
}

const runSelect = (ctx: ArgusPluginContextV1, id: string | undefined, range: string, options: CommonOptions): Promise<void> =>
	runSheetCommand(ctx, id, options, {
		execute: async ({ output }) => {
			const leased = await withSheetLease(
				ctx,
				id,
				output,
				{ operation: `select ${range}`, restore: false },
				async () => await selectRange(ctx, id, range, output),
			)
			return leased?.value ?? null
		},
		formatHuman: (result, output) => output.writeHuman(`Selected ${result.range}`),
	})

const withoutCsv = (
	data: SheetCsvResult & {
		targetSheet?: string | null
		targetIndex?: number | null
		browserRestoredGid?: string | null
		browserRestoredUrl?: string | null
	},
): Omit<SheetCsvResult, 'csv'> & Record<string, unknown> => ({
	ok: data.ok,
	title: data.title,
	targetGid: data.targetGid,
	targetUrl: data.targetUrl,
	browserCurrentGid: data.browserCurrentGid,
	browserCurrentUrl: data.browserCurrentUrl,
	targetSheet: data.targetSheet ?? null,
	targetIndex: data.targetIndex ?? null,
	browserRestoredGid: data.browserRestoredGid ?? null,
	browserRestoredUrl: data.browserRestoredUrl ?? null,
	range: data.range,
})

const leasedEval = async <T>(
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	output: Output,
	operation: string,
	restore: boolean,
	expression: string,
	evalTimeoutMs = 30_000,
): Promise<T | null> => {
	const leased = await withSheetLease(
		ctx,
		id,
		output,
		{ operation, restore },
		async () => await evalInWatcher<T>(ctx, id, expression, output, { evalTimeoutMs, requestTimeoutMs: evalTimeoutMs + 3_000 }),
	)
	return leased?.value ?? null
}
