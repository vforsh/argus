import type { ArgusPluginContextV1 } from '@vforsh/argus-plugin-api'
import { parseCsv, toTsv } from './csv.js'
import { registerSheetDimensionCommands } from './dimensionCommands.js'
import { registerSheetMutationCommands } from './mutationCommands.js'
import {
	buildAddSheetExpression,
	buildInfoSheetsExpression,
	buildListSheetsExpression,
	buildMoveSheetExpression,
	buildReadCsvExpression,
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
	type SheetTab,
} from './pageScripts.js'
import { evalInWatcher, resolveSheetTarget, selectRange, type Output } from './sheetCommandUtils.js'

type CommonOptions = {
	json?: boolean
	gid?: string
	sheet?: string
}

type ListOptions = {
	json?: boolean
	withGid?: boolean
}

type InfoOptions = {
	json?: boolean
	withGid?: boolean
}

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
}

export const registerSheetCommands = (ctx: ArgusPluginContextV1): void => {
	const sheets = ctx.program.command('sheets').alias('gs').description('Read and change the open Google Sheets tab')

	sheets
		.command('list')
		.argument('[id]', 'Watcher id for an attached Google Sheets tab')
		.description('List visible sheets in the current Google Sheets document')
		.option('--with-gid', 'Collect gid for every visible sheet by briefly switching through the tab bar')
		.option('--json', 'Output JSON for automation')
		.action(async (id: string | undefined, options: ListOptions) => runList(ctx, id, options))

	sheets
		.command('info')
		.argument('[id]', 'Watcher id for an attached Google Sheets tab')
		.description('Show metadata for the current Google Sheets document')
		.option('--with-gid', 'Collect gid for every visible sheet by briefly switching through the tab bar')
		.option('--json', 'Output JSON for automation')
		.action(async (id: string | undefined, options: InfoOptions) => runInfo(ctx, id, options))

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
		.description('Find cells in exported sheet content')
		.option('--range <a1>', 'A1 range to search')
		.option('--gid <gid>', 'Sheet gid (default: current tab gid)')
		.option('--sheet <nameOrGidOrIndex>', 'Visible sheet name, 1-based index, or gid')
		.option('--column <nameOrIndex>', 'Search only one column (header name, A-style letter, or 1-based index)')
		.option('--ignore-case', 'Case-insensitive search')
		.option('--limit <n>', 'Maximum matches to print (default: 20)')
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
}

const runList = async (ctx: ArgusPluginContextV1, id: string | undefined, options: ListOptions): Promise<void> => {
	const output = ctx.host.createOutput(options)
	const result = await evalInWatcher<SheetListResult>(ctx, id, buildListSheetsExpression({ withGid: options.withGid }), output)
	if (!result) return

	if (options.json) {
		output.writeJson(result)
		return
	}

	output.writeHuman(formatSheetList(result.sheets))
}

const runInfo = async (ctx: ArgusPluginContextV1, id: string | undefined, options: InfoOptions): Promise<void> => {
	const output = ctx.host.createOutput(options)
	const result = await evalInWatcher<SheetInfoResult>(ctx, id, buildInfoSheetsExpression({ withGid: options.withGid }), output)
	if (!result) return

	if (options.json) {
		output.writeJson(result)
		return
	}

	output.writeHuman(formatSheetInfo(result))
}

const runSwitch = async (ctx: ArgusPluginContextV1, id: string | undefined, sheet: string, options: CommonOptions): Promise<void> => {
	const output = ctx.host.createOutput(options)
	const result = await evalInWatcher<SheetSwitchResult>(ctx, id, buildSwitchSheetExpression(sheet), output)
	if (!result) return

	if (options.json) output.writeJson(result)
	else output.writeHuman(`Switched to ${formatSheetLabel(result.sheet)}`)
}

const runAdd = async (ctx: ArgusPluginContextV1, id: string | undefined, options: CommonOptions): Promise<void> => {
	const output = ctx.host.createOutput(options)
	const result = await evalInWatcher<SheetAddResult>(ctx, id, buildAddSheetExpression(), output)
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

	const result = await evalInWatcher<SheetRemoveResult>(ctx, id, buildRemoveSheetExpression(sheet), output)
	if (!result) return

	if (options.json) output.writeJson(result)
	else output.writeHuman(`Removed ${formatSheetLabel(result.removed)}`)
}

const runRename = async (ctx: ArgusPluginContextV1, id: string | undefined, sheet: string, name: string, options: CommonOptions): Promise<void> => {
	const output = ctx.host.createOutput(options)
	const result = await evalInWatcher<SheetRenameResult>(ctx, id, buildRenameSheetExpression(sheet, name), output)
	if (!result) return

	if (options.json) output.writeJson(result)
	else output.writeHuman(`Renamed ${formatSheetLabel(result.before)} to ${formatSheetLabel(result.sheet)}`)
}

const runMove = async (ctx: ArgusPluginContextV1, id: string | undefined, sheet: string, index: string, options: CommonOptions): Promise<void> => {
	const output = ctx.host.createOutput(options)
	const result = await evalInWatcher<SheetMoveResult>(ctx, id, buildMoveSheetExpression(sheet, index), output)
	if (!result) return

	if (options.json) output.writeJson(result)
	else output.writeHuman(`Moved ${formatSheetLabel(result.sheet)} to #${result.sheet.index}`)
}

const runRead = async (ctx: ArgusPluginContextV1, id: string | undefined, options: ReadOptions): Promise<void> => {
	const output = ctx.host.createOutput(options)
	const data = await readSheet(ctx, id, options, output)
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
	const data = await readSheet(ctx, id, options, output)
	if (!data) return

	const rows = parseCsv(data.csv)
	const limit = parsePositiveInt(options.limit, 20)
	if (limit == null) {
		output.writeWarn('--limit must be a positive integer')
		process.exitCode = 2
		return
	}

	const columnIndex = resolveColumnIndex(options.column, rows[0] ?? [])
	if (columnIndex === false) {
		output.writeWarn(`Unknown --column: ${options.column}`)
		process.exitCode = 2
		return
	}

	const needle = options.ignoreCase ? text.toLowerCase() : text
	const matches = findRows(rows, needle, { columnIndex, ignoreCase: options.ignoreCase ?? false, limit })

	if (options.json) {
		output.writeJson({ ...withoutCsv(data), query: text, matches })
		return
	}

	for (const match of matches) {
		output.writeHuman(`${match.a1}\t${match.value}`)
	}
	if (matches.length === 0) output.writeHuman('No matches')
}

const runSelect = async (ctx: ArgusPluginContextV1, id: string | undefined, range: string, options: CommonOptions): Promise<void> => {
	const output = ctx.host.createOutput(options)
	const result = await selectRange(ctx, id, range, output)
	if (!result) return
	if (options.json) output.writeJson(result)
	else output.writeHuman(`Selected ${result.range}`)
}

const readSheet = async (ctx: ArgusPluginContextV1, id: string | undefined, options: ReadOptions, output: Output): Promise<SheetCsvResult | null> => {
	const gid = await resolveReadGid(ctx, id, options, output)
	if (gid === false) return null
	return await evalInWatcher<SheetCsvResult>(ctx, id, buildReadCsvExpression({ range: options.range, gid }), output)
}

const resolveReadGid = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	options: ReadOptions,
	output: Output,
): Promise<string | undefined | false> => {
	if (options.gid && options.sheet) {
		output.writeWarn('Use only one sheet target: --gid or --sheet')
		process.exitCode = 2
		return false
	}
	if (!options.sheet) return options.gid

	const result = await resolveSheetTarget(ctx, id, options.sheet, output)
	if (!result) return false
	if (!result.sheet.gid) {
		output.writeWarn(`Could not resolve gid for sheet "${options.sheet}"`)
		process.exitCode = 1
		return false
	}
	return result.sheet.gid
}

const withoutCsv = (data: SheetCsvResult): Omit<SheetCsvResult, 'csv'> => ({
	ok: data.ok,
	title: data.title,
	url: data.url,
	gid: data.gid,
	range: data.range,
})

const formatSheetList = (sheets: SheetTab[]): string => {
	if (sheets.length === 0) return 'No visible sheets'
	const rows = sheets.map((sheet) => [sheet.active ? '*' : ' ', String(sheet.index), sheet.name, sheet.gid ?? ''])
	return formatTable([['', '#', 'Name', 'gid'], ...rows])
}

const formatSheetInfo = (info: SheetInfoResult): string =>
	[
		`Title: ${info.title}`,
		`Spreadsheet: ${info.spreadsheetId}`,
		`Active: ${info.active ? formatSheetLabel(info.active) : 'none'}`,
		'',
		formatSheetList(info.sheets),
	].join('\n')

const formatSheetLabel = (sheet: SheetTab): string => (sheet.gid ? `${sheet.name} (${sheet.gid})` : sheet.name)

const formatTable = (rows: string[][]): string => {
	if (rows.length === 0) return ''
	const widths = rows[0].map((_, index) => Math.min(48, Math.max(...rows.map((row) => (row[index] ?? '').length))))
	return rows
		.map((row) =>
			row
				.map((cell, index) => cell.padEnd(widths[index] ?? 0))
				.join('  ')
				.trimEnd(),
		)
		.join('\n')
}

const parsePositiveInt = (value: string | undefined, fallback: number): number | null => {
	if (value == null) return fallback
	const parsed = Number(value)
	return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

const resolveColumnIndex = (column: string | undefined, headers: readonly string[]): number | null | false => {
	if (!column) return null
	const asNumber = Number(column)
	if (Number.isInteger(asNumber) && asNumber > 0) return asNumber - 1
	if (/^[A-Za-z]+$/.test(column)) return columnLettersToIndex(column)
	const index = headers.findIndex((header) => header === column)
	return index >= 0 ? index : false
}

const columnLettersToIndex = (letters: string): number => {
	let index = 0
	for (const char of letters.toUpperCase()) {
		index = index * 26 + (char.charCodeAt(0) - 64)
	}
	return index - 1
}

const findRows = (rows: string[][], needle: string, options: { columnIndex: number | null; ignoreCase: boolean; limit: number }) => {
	const matches: Array<{ row: number; column: number; a1: string; value: string }> = []
	for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
		const row = rows[rowIndex]
		const start = options.columnIndex ?? 0
		const end = options.columnIndex ?? row.length - 1
		for (let columnIndex = start; columnIndex <= end; columnIndex++) {
			const value = row[columnIndex] ?? ''
			const haystack = options.ignoreCase ? value.toLowerCase() : value
			if (haystack.includes(needle)) {
				matches.push({ row: rowIndex + 1, column: columnIndex + 1, a1: `${indexToColumnLetters(columnIndex)}${rowIndex + 1}`, value })
				if (matches.length >= options.limit) return matches
			}
		}
	}
	return matches
}

const indexToColumnLetters = (index: number): string => {
	let value = index + 1
	let letters = ''
	while (value > 0) {
		const rem = (value - 1) % 26
		letters = String.fromCharCode(65 + rem) + letters
		value = Math.floor((value - 1) / 26)
	}
	return letters
}
