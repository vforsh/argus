import type { ArgusPluginContextV1 } from '@vforsh/argus-plugin-api'
import { parseCsv, parseTsv, toTsv } from './csv.js'
import {
	buildClipboardExpression,
	buildReadCsvExpression,
	buildSelectRangeExpression,
	type SheetClipboardResult,
	type SheetCsvResult,
	type SheetSelectResult,
} from './pageScripts.js'

type Output = ReturnType<ArgusPluginContextV1['host']['createOutput']>

type CommonOptions = {
	json?: boolean
	gid?: string
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

	const selected = await selectRange(ctx, id, range, output)
	if (!selected) return
	const copied = await evalInWatcher<SheetClipboardResult>(ctx, id, buildClipboardExpression(tsv), output)
	if (!copied) return

	const pasted = await dispatchKey(ctx, id, output, { key: 'v', modifiers: 'ctrl' })
	if (!pasted) return

	await sleep(1_500)
	if (options.json) output.writeJson({ ok: true, range: selected.range, clipboard: copied.method })
	else output.writeHuman(`Pasted ${parseTsv(tsv).length} row(s) into ${selected.range}`)
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
