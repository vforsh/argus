import { parsePositiveInt, runtimeError, usageError } from './cliArgs.js'
import { readFile, writeFile } from 'node:fs/promises'
import type { ArgusPluginContextV1 } from '@vforsh/argus-plugin-api'
import type { Command } from 'commander'
import { parseCsv, parseTsv } from './csv.js'
import { buildKeyedRows, diffKeyedRows, type KeyedDiffResult, type KeyedRow } from './keyedDiff.js'
import { buildLocateRowsExpression, type ExactLocatorResult, type ExactRowMatch } from './locatorPageScripts.js'
import { parseTimeoutMs } from './mutationCommands.js'
import { findExportHeaderIndex, type ExportRowCandidate } from './queryModel.js'
import { buildSheetSchema, resolveHeader } from './schema.js'
import { evalInWatcher, type Output } from './sheetCommandUtils.js'
import { readExactPhysicalRow, readSheetCsv } from './sheetRead.js'

type DiffOptions = {
	json?: boolean
	sheet: string
	headerRow?: string
	against: string
	key: string
	columns: string
	locate?: boolean
	maxRow?: string
	locateTimeout?: string
	emitPlan?: string
}

/** Register the local CSV/TSV keyed diff command. */
export const registerSheetDiffCommand = (ctx: ArgusPluginContextV1, sheets: Command): void => {
	sheets
		.command('diff')
		.argument('[id]', 'Watcher id for an attached Google Sheets tab')
		.description('Diff a sheet against a local CSV/TSV by semantic key')
		.requiredOption('--sheet <nameOrGidOrIndex>', 'Target sheet name, 1-based index, or gid')
		.option('--header-row <n>', 'Physical sheet header row (default: 1)', '1')
		.requiredOption('--against <path>', 'Local CSV/TSV file')
		.requiredOption('--key <header>', 'Unique key header')
		.requiredOption('--columns <headers>', 'Comma-separated columns to compare')
		.option('--no-locate', 'Skip exact physical coordinates for changed/removed sheet rows')
		.option('--max-row <n>', 'Maximum physical row scanned while locating (default: 5000)', '5000')
		.option('--locate-timeout <duration>', 'Internal exact locator deadline (default: 20s)', '20s')
		.option('--emit-plan <path>', 'Write a safe version-1 apply manifest when all differences are updates')
		.option('--json', 'Output stable JSON for automation')
		.action(async (id: string | undefined, options: DiffOptions) => runDiff(ctx, id, options))
}

const runDiff = async (ctx: ArgusPluginContextV1, id: string | undefined, options: DiffOptions): Promise<void> => {
	const output = ctx.host.createOutput(options)
	const headerRow = parsePositiveInt(options.headerRow ?? '1')
	const maxRow = parsePositiveInt(options.maxRow ?? '5000')
	if (headerRow == null || maxRow == null) return usageError(output, '--header-row and --max-row must be positive integers')
	let localText: string
	try {
		localText = (await readFile(options.against, 'utf8')).replace(/^\uFEFF/, '')
	} catch (error) {
		return usageError(output, `Failed to read --against file: ${error instanceof Error ? error.message : String(error)}`)
	}
	const localTable = (options.against.toLowerCase().endsWith('.tsv') ? parseTsv(localText) : parseCsv(localText)).filter((row) =>
		row.some((cell) => cell !== ''),
	)
	if (localTable.length === 0) return usageError(output, '--against file is empty')

	const exactHeader = await readExactPhysicalRow(ctx, id, { sheet: options.sheet, row: headerRow }, output)
	if (!exactHeader) return
	const schema = buildSheetSchema(exactHeader.values, headerRow)
	const keyHeader = resolveHeader(schema, options.key)
	if (typeof keyHeader === 'string') return usageError(output, keyHeader)
	const columnHeaders = []
	for (const name of options.columns
		.split(',')
		.map((value) => value.trim())
		.filter(Boolean)) {
		const header = resolveHeader(schema, name)
		if (typeof header === 'string') return usageError(output, header)
		columnHeaders.push(header)
	}
	if (columnHeaders.length === 0) return usageError(output, '--columns must include at least one header')

	const exported = await readSheetCsv(ctx, id, { sheet: options.sheet }, output)
	if (!exported) return
	const exportRows = parseCsv(exported.csv)
	const headerExportIndex = findExportHeaderIndex(exportRows, schema)
	if (headerExportIndex < 0) return runtimeError(output, `Physical header row ${headerRow} was not found in the whole-sheet export.`)
	const sheetData = exportRows.slice(headerExportIndex + 1)
	const headerNames = schema.headers.map((header) => header.original)
	const compareNames = columnHeaders.map((header) => header.original)
	const sheetRows = buildKeyedRows(sheetData, headerNames, keyHeader.original, compareNames, 'Sheet')
	if (typeof sheetRows === 'string') return runtimeError(output, sheetRows)
	for (let index = 0; index < sheetRows.length; index++) sheetRows[index].exportRow = headerExportIndex + index + 2
	const localRows = buildKeyedRows(localTable.slice(1), localTable[0], keyHeader.original, compareNames, 'Local file')
	if (typeof localRows === 'string') return usageError(output, localRows)
	const diff = diffKeyedRows(sheetRows, localRows, compareNames)

	let locator: ExactLocatorResult<ExactRowMatch> | null = null
	if (options.locate !== false && (diff.removals.length > 0 || diff.changes.length > 0)) {
		const relevantKeys = new Set([...diff.removals.map((row) => row.key), ...diff.changes.map((change) => change.key)])
		const candidates: ExportRowCandidate[] = sheetRows
			.filter((row) => relevantKeys.has(row.key))
			.map((row) => ({ exportRow: row.exportRow as number, values: sheetData[(row.exportRow as number) - headerExportIndex - 2] ?? [] }))
		const deadlineMs = Math.min(25_000, parseTimeoutMs(options.locateTimeout, 20_000) ?? 0)
		if (deadlineMs <= 0) return usageError(output, '--locate-timeout must be a positive duration')
		locator = await evalInWatcher<ExactLocatorResult<ExactRowMatch>>(
			ctx,
			id,
			buildLocateRowsExpression({
				gid: exported.targetGid,
				startRow: headerRow + 1,
				maxRow,
				width: schema.headers.length,
				candidates,
				deadlineMs,
			}),
			output,
			{ evalTimeoutMs: deadlineMs + 2_000, requestTimeoutMs: deadlineMs + 5_000 },
		)
		if (!locator) return
		attachLocations(sheetRows, locator.matches)
		if (!locator.complete) process.exitCode = 1
	}
	const locatedDiff = diffKeyedRows(sheetRows, localRows, compareNames)
	let planPath: string | null = null
	if (options.emitPlan) {
		if (locatedDiff.additions.length > 0 || locatedDiff.removals.length > 0) {
			return runtimeError(
				output,
				'Refusing --emit-plan because additions/removals need explicit semantic insertion/deletion policy; no partial plan was written.',
			)
		}
		const manifest = buildUpdateManifest(options.sheet, headerRow, keyHeader.original, compareNames, locatedDiff)
		try {
			await writeFile(options.emitPlan, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
			planPath = options.emitPlan
		} catch (error) {
			return runtimeError(output, `Failed to write --emit-plan: ${error instanceof Error ? error.message : String(error)}`)
		}
	}
	const payload = {
		ok: locator?.complete !== false,
		targetSheet: exported.targetSheet,
		targetGid: exported.targetGid,
		targetUrl: exported.targetUrl,
		against: options.against,
		key: keyHeader.original,
		columns: compareNames,
		...locatedDiff,
		locator: locator ? { scannedRows: locator.scannedRows, complete: locator.complete, reason: locator.reason } : null,
		emitPlan: planPath,
	}
	if (options.json) output.writeJson(payload)
	else writeHumanDiff(output, payload)
}

const attachLocations = (rows: KeyedRow[], matches: ExactRowMatch[]): void => {
	const locations = new Map(matches.map((match) => [match.exportRow, match]))
	for (const row of rows) {
		const match = row.exportRow == null ? null : locations.get(row.exportRow)
		if (!match) continue
		row.sheetRow = match.sheetRow
		row.a1 = match.a1
	}
}

const buildUpdateManifest = (sheet: string, headerRow: number, keyColumn: string, columns: string[], diff: KeyedDiffResult) => ({
	version: 1,
	operations: columns
		.map((valueColumn) => {
			const changes: Record<string, { expect: string; set: string }> = {}
			for (const change of diff.changes) {
				const column = change.columns.find((candidate) => candidate.column === valueColumn)
				if (column) changes[change.key] = { expect: column.before, set: column.after }
			}
			return { op: 'updateByKey' as const, sheet, headerRow, keyColumn, valueColumn, changes }
		})
		.filter((operation) => Object.keys(operation.changes).length > 0),
})

const writeHumanDiff = (
	output: Output,
	payload: {
		additions: KeyedRow[]
		removals: KeyedRow[]
		changes: KeyedDiffResult['changes']
		unchanged: number
		emitPlan: string | null
		locator: { complete: boolean; reason: string } | null
	},
): void => {
	for (const row of payload.additions) output.writeHuman(`+ ${row.key}\t${JSON.stringify(row.values)}`)
	for (const row of payload.removals) output.writeHuman(`- ${row.a1 ?? `export:${row.exportRow}`}\t${row.key}\t${JSON.stringify(row.values)}`)
	for (const change of payload.changes) {
		for (const column of change.columns)
			output.writeHuman(
				`~ ${change.before.a1 ?? `export:${change.before.exportRow}`}\t${change.key}\t${column.column}: ${JSON.stringify(column.before)} -> ${JSON.stringify(column.after)}`,
			)
	}
	output.writeHuman(`Summary: +${payload.additions.length} -${payload.removals.length} ~${payload.changes.length} =${payload.unchanged}`)
	if (payload.emitPlan) output.writeHuman(`Apply manifest: ${payload.emitPlan}`)
	if (payload.locator && !payload.locator.complete)
		output.writeWarn(`Locator incomplete (${payload.locator.reason}); unresolved rows have exportRow only.`)
}
