import { parsePositiveInt, usageError } from './cliArgs.js'
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

const runList = async (ctx: ArgusPluginContextV1, id: string | undefined, options: ListOptions): Promise<void> => {
	const output = ctx.host.createOutput(options)
	const deadlineMs = parseTimeoutMs(options.deadline, 20_000)
	if (deadlineMs == null) return usageError(output, '--deadline must be a positive duration such as 10s or 20s')
	const base = await evalInWatcher<SheetListResult>(ctx, id, buildListSheetsExpression({ withGid: false }), output)
	if (!base) return
	const result = options.withGid ? await collectGidsStepped(ctx, id, output, base, options, Math.min(25_000, deadlineMs)) : base
	if (!result) return

	if (options.json) {
		output.writeJson(result)
		return
	}

	output.writeHuman(formatSheetList(result.sheets))
}

const runInfo = async (ctx: ArgusPluginContextV1, id: string | undefined, options: InfoOptions): Promise<void> => {
	const output = ctx.host.createOutput(options)
	const deadlineMs = parseTimeoutMs(options.deadline, 20_000)
	if (deadlineMs == null) return usageError(output, '--deadline must be a positive duration such as 10s or 20s')
	const base = await evalInWatcher<SheetInfoResult>(ctx, id, buildInfoSheetsExpression({ withGid: false }), output)
	if (!base) return
	const list = options.withGid ? await collectGidsStepped(ctx, id, output, base, options, Math.min(25_000, deadlineMs)) : base
	if (!list) return
	const result: SheetInfoResult = { ...base, sheets: list.sheets, active: list.sheets.find((sheet) => sheet.active) ?? null }

	if (options.json) {
		output.writeJson(result)
		return
	}

	output.writeHuman(formatSheetInfo(result))
}

const runResolve = async (ctx: ArgusPluginContextV1, id: string | undefined, sheet: string, options: CommonOptions): Promise<void> => {
	const output = ctx.host.createOutput(options)
	const leased = await withSheetLease(
		ctx,
		id,
		output,
		{ operation: `resolve sheet ${sheet}`, restore: true },
		async () => await resolveSheetTarget(ctx, id, sheet, output),
	)
	const result = leased?.value
	if (!result) return
	const payload = {
		...result,
		sheet: { ...result.sheet, active: (leased.release?.browserCurrentGid ?? result.browser.restoredGid) === result.target.gid },
		browser: {
			...result.browser,
			restoredGid: leased.release?.browserCurrentGid ?? result.browser.restoredGid,
			restoredUrl: leased.release?.browserCurrentUrl ?? result.browser.restoredUrl,
		},
	}
	if (options.json) output.writeJson(payload)
	else output.writeHuman(`${payload.target.name}\t${payload.target.gid}\t${payload.target.url}`)
}

const runSwitch = async (ctx: ArgusPluginContextV1, id: string | undefined, sheet: string, options: CommonOptions): Promise<void> => {
	const output = ctx.host.createOutput(options)
	const result = await leasedEval<SheetSwitchResult>(ctx, id, output, `switch to sheet ${sheet}`, false, buildSwitchSheetExpression(sheet))
	if (!result) return

	if (options.json) output.writeJson(result)
	else output.writeHuman(`Switched to ${formatSheetLabel(result.sheet)}`)
}

const runAdd = async (ctx: ArgusPluginContextV1, id: string | undefined, options: CommonOptions): Promise<void> => {
	const output = ctx.host.createOutput(options)
	const result = await leasedEval<SheetAddResult>(ctx, id, output, 'add sheet', false, buildAddSheetExpression())
	if (!result) return

	if (options.json) output.writeJson(result)
	else output.writeHuman(`Added ${formatSheetLabel(result.sheet)}`)
}

const runRemove = async (ctx: ArgusPluginContextV1, id: string | undefined, sheet: string, options: RemoveOptions): Promise<void> => {
	const output = ctx.host.createOutput(options)
	if (!options.force) {
		output.writeWarn('Refusing to remove a sheet without --force')
		process.exitCode = 2
		return
	}

	const result = await leasedEval<SheetRemoveResult>(ctx, id, output, `remove sheet ${sheet}`, false, buildRemoveSheetExpression(sheet))
	if (!result) return

	if (options.json) output.writeJson(result)
	else output.writeHuman(`Removed ${formatSheetLabel(result.removed)}`)
}

const runRename = async (ctx: ArgusPluginContextV1, id: string | undefined, sheet: string, name: string, options: CommonOptions): Promise<void> => {
	const output = ctx.host.createOutput(options)
	const result = await leasedEval<SheetRenameResult>(ctx, id, output, `rename sheet ${sheet}`, false, buildRenameSheetExpression(sheet, name))
	if (!result) return

	if (options.json) output.writeJson(result)
	else output.writeHuman(`Renamed ${formatSheetLabel(result.before)} to ${formatSheetLabel(result.sheet)}`)
}

const runMove = async (ctx: ArgusPluginContextV1, id: string | undefined, sheet: string, index: string, options: CommonOptions): Promise<void> => {
	const output = ctx.host.createOutput(options)
	const result = await leasedEval<SheetMoveResult>(ctx, id, output, `move sheet ${sheet}`, false, buildMoveSheetExpression(sheet, index))
	if (!result) return

	if (options.json) output.writeJson(result)
	else output.writeHuman(`Moved ${formatSheetLabel(result.sheet)} to #${result.sheet.index}`)
}

const runRead = async (ctx: ArgusPluginContextV1, id: string | undefined, options: ReadOptions): Promise<void> => {
	const output = ctx.host.createOutput(options)
	const data = await readSheetCsv(ctx, id, options, output)
	if (!data) return

	const rows = parseCsv(data.csv)
	const format = options.json ? 'json' : (options.format ?? 'table')
	if (format === 'json') {
		output.writeJson({ ...withoutCsv(data), rows })
	} else if (format === 'csv') {
		output.writeHuman(data.csv)
	} else if (format === 'tsv') {
		output.writeHuman(toTsv(rows))
	} else {
		output.writeHuman(formatTable(rows))
	}
}

const runFind = async (ctx: ArgusPluginContextV1, id: string | undefined, text: string, options: FindOptions): Promise<void> => {
	const output = ctx.host.createOutput(options)
	const data = await readSheetCsv(ctx, id, options, output)
	if (!data) return

	const rows = parseCsv(data.csv)
	const limit = parsePositiveInt(options.limit, { fallback: 20 })
	if (limit == null) {
		output.writeWarn('--limit must be a positive integer')
		process.exitCode = 2
		return
	}

	const columnIndex = resolveFindColumn(options.column, rows[0] ?? [])
	if (columnIndex === false) {
		output.writeWarn(`Unknown --column: ${options.column}`)
		process.exitCode = 2
		return
	}

	const needle = options.ignoreCase ? text.toLowerCase() : text
	const candidates = findExportMatches(rows, needle, { columnIndex, ignoreCase: options.ignoreCase ?? false, limit })
	const maxRowFlag = parsePositiveInt(options.maxRow, { fallback: 5_000 })
	const deadlineMs = parseTimeoutMs(options.locateTimeout, 20_000)
	if (maxRowFlag == null) return usageError(output, '--max-row must be a positive integer')
	if (deadlineMs == null) return usageError(output, '--locate-timeout must be a positive duration such as 5s or 20s')
	const bounds = options.range ? parseA1Range(options.range) : null
	if (options.range && !bounds) return usageError(output, '--range must be a physical A1 cell range for coordinate-safe find')
	const startRow = bounds ? bounds.startRow + 1 : 1
	const maxRow = bounds ? Math.min(maxRowFlag, bounds.endRow + 1) : maxRowFlag
	const lastColumn = bounds?.endColumn ?? Math.max(0, ...rows.map((row) => row.length - 1))
	let locator: ExactLocatorResult<ExactCellMatch> = { ok: true, matches: [], scannedRows: 0, complete: true, reason: 'found' }
	if (candidates.length > 0) {
		const internalDeadline = Math.min(25_000, deadlineMs)
		const located = await evalInWatcher<ExactLocatorResult<ExactCellMatch>>(
			ctx,
			id,
			buildLocateCellsExpression({
				gid: data.targetGid,
				startRow,
				maxRow,
				firstColumn: bounds?.startColumn ?? 0,
				lastColumn,
				needle,
				columnIndex,
				ignoreCase: options.ignoreCase ?? false,
				limit,
				expectedMatches: candidates.length,
				deadlineMs: internalDeadline,
			}),
			output,
			{ evalTimeoutMs: internalDeadline + 2_000, requestTimeoutMs: internalDeadline + 5_000 },
		)
		if (!located) return
		locator = located
		if (!locator.complete) process.exitCode = 1
	}

	if (options.json) {
		output.writeJson({
			...withoutCsv(data),
			query: text,
			candidateMatches: candidates,
			matches: locator.matches,
			locator: { complete: locator.complete, reason: locator.reason, scannedRows: locator.scannedRows },
		})
		return
	}

	for (const match of locator.matches) {
		output.writeHuman(`${match.a1}\t${match.value}`)
	}
	if (locator.matches.length === 0) output.writeHuman('No matches')
	if (!locator.complete) output.writeWarn(`Exact locator incomplete (${locator.reason}); no export row was presented as a physical A1 coordinate.`)
}

const runSelect = async (ctx: ArgusPluginContextV1, id: string | undefined, range: string, options: CommonOptions): Promise<void> => {
	const output = ctx.host.createOutput(options)
	const leased = await withSheetLease(
		ctx,
		id,
		output,
		{ operation: `select ${range}`, restore: false },
		async () => await selectRange(ctx, id, range, output),
	)
	const result = leased?.value
	if (!result) return
	if (options.json) output.writeJson(result)
	else output.writeHuman(`Selected ${result.range}`)
}

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
