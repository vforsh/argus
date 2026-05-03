import type { ArgusPluginContextV1 } from '@vforsh/argus-plugin-api'
import { parseCsv, parseTsv, toTsv } from './csv.js'
import {
	buildAddSheetExpression,
	buildInfoSheetsExpression,
	buildListSheetsExpression,
	buildMoveSheetExpression,
	buildPrepareWriteExpression,
	buildReadCsvExpression,
	buildRenameSheetExpression,
	buildRemoveSheetExpression,
	buildSelectRangeExpression,
	buildSwitchSheetExpression,
	buildVerifyWriteExpression,
	type SheetAddResult,
	type SheetCsvResult,
	type SheetInfoResult,
	type SheetListResult,
	type SheetMoveResult,
	type SheetPreparedWriteResult,
	type SheetRenameResult,
	type SheetRemoveResult,
	type SheetSelectResult,
	type SheetSwitchResult,
	type SheetTab,
	type SheetWriteVerificationResult,
} from './pageScripts.js'

type Output = ReturnType<ArgusPluginContextV1['host']['createOutput']>

type CommonOptions = {
	json?: boolean
	gid?: string
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

type WriteOptions = CommonOptions & {
	value?: string
	tsv?: string
	stdin?: boolean
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
		.option('--format <type>', 'Output format: table, tsv, csv, json (default: table)')
		.option('--json', 'Output JSON for automation')
		.action(async (id: string | undefined, options: ReadOptions) => runRead(ctx, id, options))

	sheets
		.command('export')
		.argument('[id]', 'Watcher id for an attached Google Sheets tab')
		.description('Export sheet content as TSV, CSV, or JSON')
		.option('--range <a1>', 'A1 range to export')
		.option('--gid <gid>', 'Sheet gid (default: current tab gid)')
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

	sheets
		.command('write')
		.argument('[id]', 'Watcher id for an attached Google Sheets tab')
		.argument('<range>', 'A1 range whose top-left cell receives the pasted content')
		.description('Paste a value or TSV block into a range in the open Google Sheets tab')
		.option('--value <text>', 'Single-cell value to paste')
		.option('--tsv <text>', 'TSV block to paste')
		.option('--stdin', 'Read TSV from stdin')
		.option('--json', 'Output JSON for automation')
		.action(async (id: string | undefined, range: string, options: WriteOptions) => runWrite(ctx, id, range, options))
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
	const data = await readSheet(ctx, id, options)
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
	const data = await readSheet(ctx, id, options)
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

const runWrite = async (ctx: ArgusPluginContextV1, id: string | undefined, range: string, options: WriteOptions): Promise<void> => {
	const output = ctx.host.createOutput(options)
	const tsv = await resolveWriteTsv(options)
	if (tsv == null) {
		output.writeWarn('Provide exactly one of --value, --tsv, or --stdin')
		process.exitCode = 2
		return
	}

	const values = parseTsv(tsv)
	const prepared = await prepareUiWrite(ctx, id, range, tsv, values, output)
	if (!prepared) return

	const selected = await dispatchKey(ctx, id, output, { key: 'Enter', selector: '#t-name-box' })
	if (!selected) return

	const pasted = await dispatchKey(ctx, id, output, { key: 'v', modifiers: 'ctrl' })
	if (!pasted) return

	const verification = await evalInWatcher<SheetWriteVerificationResult>(
		ctx,
		id,
		buildVerifyWriteExpression({ range: prepared.verificationRange, expectedValues: values, timeoutMs: 1_500 }),
		output,
	)
	if (!verification) return

	writeWriteResult(output, options, {
		ok: true,
		range: prepared.range,
		method: prepared.method,
		rows: values.length,
		verified: verification.verified,
		verificationRange: verification.range,
	})
}

const readSheet = async (ctx: ArgusPluginContextV1, id: string | undefined, options: ReadOptions): Promise<SheetCsvResult | null> => {
	const output = ctx.host.createOutput(options)
	return await evalInWatcher<SheetCsvResult>(ctx, id, buildReadCsvExpression({ range: options.range, gid: options.gid }), output)
}

const selectRange = async (ctx: ArgusPluginContextV1, id: string | undefined, range: string, output: Output): Promise<SheetSelectResult | null> => {
	const result = await evalInWatcher<SheetSelectResult>(ctx, id, buildSelectRangeExpression(range), output)
	if (!result) return null

	const selected = await dispatchKey(ctx, id, output, { key: 'Enter', selector: '#t-name-box' })
	if (!selected) return null

	await sleep(200)
	return result
}

const prepareUiWrite = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	range: string,
	tsv: string,
	values: string[][],
	output: Output,
): Promise<SheetPreparedWriteResult | null> => {
	const columnCount = Math.max(1, ...values.map((row) => row.length))
	return await evalInWatcher<SheetPreparedWriteResult>(
		ctx,
		id,
		buildPrepareWriteExpression({ range, text: tsv, rowCount: values.length, columnCount }),
		output,
	)
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const resolveWriteTsv = async (options: WriteOptions): Promise<string | null> => {
	const selected = [options.value != null, options.tsv != null, options.stdin === true].filter(Boolean).length
	if (selected !== 1) return null
	if (options.value != null) return toTsv([[options.value]])
	if (options.tsv != null) return options.tsv
	return await readStdin()
}

const writeWriteResult = (
	output: Output,
	options: WriteOptions,
	result: { ok: true; range: string; method: string; rows: number; verified: boolean; verificationRange?: string },
): void => {
	if (options.json) {
		output.writeJson(result)
		return
	}

	const suffix = result.verified ? '' : ' (verification timed out)'
	output.writeHuman(`Wrote ${result.rows} row(s) into ${result.range} via ${result.method}${suffix}`)
}

const readStdin = async (): Promise<string> =>
	new Promise((resolve, reject) => {
		let data = ''
		process.stdin.setEncoding('utf8')
		process.stdin.on('data', (chunk) => {
			data += chunk
		})
		process.stdin.on('end', () => resolve(data))
		process.stdin.on('error', reject)
		process.stdin.resume()
	})

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
