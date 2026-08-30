import { parsePositiveInt, runtimeError, usageError } from './cliArgs.js'
import { failCommand } from './commandExit.js'
import type { ArgusPluginContextV1 } from '@vforsh/argus-plugin-api'
import type { Command } from 'commander'
import { parseCsv } from './csv.js'
import { buildLocateRowsExpression, type ExactLocatorResult, type ExactRowMatch } from './locatorPageScripts.js'
import { parseTimeoutMs } from './mutationCommands.js'
import {
	findExportHeaderIndex,
	parseSelectHeaders,
	parseWhereExpression,
	projectCandidate,
	queryExportRows,
	type ExportRowCandidate,
} from './queryModel.js'
import { buildSheetSchema, type SheetSchema } from './schema.js'
import { evalInWatcher, type Output, runSheetCommand } from './sheetCommandUtils.js'
import { readExactPhysicalRow, readSheetCsv } from './sheetRead.js'

type InspectionOptions = {
	json?: boolean
	sheet?: string
	gid?: string
	headerRow?: string
}

type QueryOptions = InspectionOptions & {
	where: string
	select?: string
	limit?: string
	locate?: boolean
	maxRow?: string
	locateTimeout?: string
	expectCount?: string
	expectUnique?: boolean
}

/** Register header-aware schema and query commands. */
export const registerSheetInspectionCommands = (ctx: ArgusPluginContextV1, sheets: Command): void => {
	sheets
		.command('schema')
		.argument('[id]', 'Watcher id for an attached Google Sheets tab')
		.description('Inspect a physical header row without deriving coordinates from a collapsed export')
		.requiredOption('--sheet <nameOrGidOrIndex>', 'Target sheet name, 1-based index, or gid')
		.option('--header-row <n>', 'Physical header row (default: 1)', '1')
		.option('--json', 'Output stable JSON for automation')
		.action(async (id: string | undefined, options: InspectionOptions) => runSchema(ctx, id, options))

	sheets
		.command('query')
		.argument('[id]', 'Watcher id for an attached Google Sheets tab')
		.description('Query rows by named headers; coordinates are exact only with --locate')
		.requiredOption('--sheet <nameOrGidOrIndex>', 'Target sheet name, 1-based index, or gid')
		.option('--header-row <n>', 'Physical header row (default: 1)', '1')
		.requiredOption('--where <expression>', 'Equality, in [...], substring/contains, or regex predicate')
		.option('--select <headers>', 'Comma-separated output headers (default: all non-empty headers)')
		.option('--limit <n>', 'Maximum rows emitted after assertions (default: 100)', '100')
		.option('--locate', 'Resolve each emitted row through bounded exact physical-row reads')
		.option('--max-row <n>', 'Maximum physical row scanned by --locate (default: 5000)', '5000')
		.option('--locate-timeout <duration>', 'Internal locator deadline, capped below watcher timeout (default: 20s)', '20s')
		.option('--expect-count <n>', 'Fail unless the full untruncated match count equals n')
		.option('--expect-unique', 'Fail unless the full untruncated query has exactly one match')
		.option('--json', 'Output stable JSON for automation')
		.action(async (id: string | undefined, options: QueryOptions) => runQuery(ctx, id, options))
}

const runSchema = (ctx: ArgusPluginContextV1, id: string | undefined, options: InspectionOptions): Promise<void> =>
	runSheetCommand(ctx, id, options, {
		validate: (opts, output) => parsePositiveInt(opts.headerRow ?? '1', { flag: '--header-row', output }),
		execute: async ({ output, validated: headerRow }) => {
			const schemaResult = await loadSchema(ctx, id, options, headerRow, output)
			if (!schemaResult) return null
			return {
				ok: true,
				targetSheet: schemaResult.data.targetSheet,
				targetGid: schemaResult.data.targetGid,
				targetUrl: schemaResult.data.targetUrl,
				browserCurrentUrl: schemaResult.data.browserCurrentUrl,
				browserRestoredUrl: schemaResult.data.browserRestoredUrl,
				...schemaResult.schema,
			}
		},
		formatHuman: (payload, output) => writeSchemaHuman(output, payload),
	})

const runQuery = (ctx: ArgusPluginContextV1, id: string | undefined, options: QueryOptions): Promise<void> =>
	runSheetCommand(ctx, id, options, {
		validate: (opts, output) => {
			// Both flags are parsed before either is checked so a run with two bad flags reports both.
			const headerRow = parsePositiveInt(opts.headerRow ?? '1', { flag: '--header-row', output })
			const limit = parsePositiveInt(opts.limit ?? '100', { flag: '--limit', output })
			return headerRow == null || limit == null ? null : { headerRow, limit }
		},
		execute: async ({ output, validated: { headerRow, limit } }) => {
			const schemaResult = await loadSchema(ctx, id, options, headerRow, output)
			if (!schemaResult) return null

			const predicate = parseWhereExpression(options.where, schemaResult.schema)
			if (typeof predicate === 'string') return usageError(output, predicate)

			const selected = parseSelectHeaders(options.select, schemaResult.schema)
			if (typeof selected === 'string') return usageError(output, selected)

			const exported = await readSheetCsv(ctx, id, { sheet: options.sheet, gid: options.gid }, output)
			if (!exported) return null

			const rows = parseCsv(exported.csv)
			const headerExportIndex = findExportHeaderIndex(rows, schemaResult.schema)
			if (headerExportIndex < 0) {
				return runtimeError(output, `Physical header row ${headerRow} was not found in the whole-sheet export.`)
			}

			const allMatches = queryExportRows(rows, headerExportIndex, predicate)
			const expectedCount = options.expectUnique
				? 1
				: options.expectCount == null
					? null
					: parsePositiveInt(options.expectCount, { flag: '--expect-count', output })
			if (options.expectCount != null && expectedCount == null) return null
			if (expectedCount != null && allMatches.length !== expectedCount) {
				return runtimeError(output, `Query assertion failed: expected ${expectedCount} match(es), found ${allMatches.length}.`)
			}

			const emitted = allMatches.slice(0, limit)
			let located: ExactLocatorResult<ExactRowMatch> | null = null
			if (options.locate && emitted.length > 0) {
				located = await locateRows(ctx, id, output, exported.targetGid, headerRow + 1, emitted, schemaResult.schema.headers.length, options)
				if (!located) return null
				if (!located.complete) failCommand(1)
			}

			const byExportRow = new Map(located?.matches.map((match) => [match.exportRow, match]) ?? [])
			const resultRows = emitted.map((candidate) => {
				const exact = byExportRow.get(candidate.exportRow)
				return {
					exportRow: candidate.exportRow,
					location: exact ? { sheetRow: exact.sheetRow, a1: exact.a1, exactVerified: true } : null,
					values: projectCandidate(candidate, selected),
				}
			})

			return {
				ok: located?.complete !== false,
				targetSheet: exported.targetSheet,
				targetGid: exported.targetGid,
				targetUrl: exported.targetUrl,
				browserCurrentUrl: exported.browserCurrentUrl,
				browserRestoredUrl: exported.browserRestoredUrl,
				headerRow,
				where: options.where,
				select: selected.map((header) => header.original),
				matchCount: allMatches.length,
				emittedCount: resultRows.length,
				truncated: allMatches.length > resultRows.length,
				locator: located ? { scannedRows: located.scannedRows, complete: located.complete, reason: located.reason } : null,
				rows: resultRows,
			}
		},
		formatHuman: (payload, output) => writeQueryHuman(output, payload),
	})

const loadSchema = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	options: InspectionOptions,
	headerRow: number,
	output: Output,
): Promise<{ schema: SheetSchema; data: Awaited<ReturnType<typeof readSheetCsv>> & {} } | null> => {
	const exact = await readExactPhysicalRow(ctx, id, { sheet: options.sheet, gid: options.gid, row: headerRow }, output)
	if (!exact) return null
	return { schema: buildSheetSchema(exact.values, headerRow), data: exact.data }
}

const locateRows = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	output: Output,
	gid: string,
	startRow: number,
	candidates: ExportRowCandidate[],
	width: number,
	options: QueryOptions,
): Promise<ExactLocatorResult<ExactRowMatch> | null> => {
	const maxRow = parsePositiveInt(options.maxRow ?? '5000', { flag: '--max-row', output })
	const deadlineMs = parseTimeoutMs(options.locateTimeout, 20_000)
	if (maxRow == null) return null
	if (deadlineMs == null) return usageError(output, '--locate-timeout must be a positive duration such as 5s or 20s')

	const internalDeadlineMs = Math.min(25_000, deadlineMs)
	return await evalInWatcher<ExactLocatorResult<ExactRowMatch>>(
		ctx,
		id,
		buildLocateRowsExpression({ gid, startRow, maxRow, width, candidates, deadlineMs: internalDeadlineMs }),
		output,
		{ evalTimeoutMs: internalDeadlineMs + 2_000, requestTimeoutMs: internalDeadlineMs + 5_000 },
	)
}

const writeSchemaHuman = (output: Output, payload: { targetSheet: string | null; headerRow: number; headers: SheetSchema['headers'] }): void => {
	output.writeHuman(`Sheet: ${payload.targetSheet ?? '(current)'}; physical header row: ${payload.headerRow}`)
	for (const header of payload.headers) {
		const notes = [header.empty ? 'empty' : '', header.duplicate ? `duplicate ${header.duplicateIndex}/${header.duplicateCount}` : ''].filter(
			Boolean,
		)
		output.writeHuman(`${header.a1}\t${JSON.stringify(header.original)}\t${header.normalized}${notes.length ? `\t${notes.join(', ')}` : ''}`)
	}
}

const writeQueryHuman = (
	output: Output,
	payload: {
		targetSheet: string | null
		matchCount: number
		truncated: boolean
		rows: Array<{ exportRow: number; location: { a1: string } | null; values: Record<string, string> }>
		locator: { complete: boolean; reason: string } | null
	},
): void => {
	output.writeHuman(`Sheet: ${payload.targetSheet ?? '(current)'}; matches: ${payload.matchCount}${payload.truncated ? ' (output truncated)' : ''}`)
	for (const row of payload.rows) output.writeHuman(`${row.location?.a1 ?? `export:${row.exportRow}`}\t${JSON.stringify(row.values)}`)
	if (payload.locator && !payload.locator.complete)
		output.writeWarn(`Physical locator incomplete: ${payload.locator.reason}; no unresolved row was assigned an A1 coordinate.`)
}
