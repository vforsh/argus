import type { ArgusPluginContextV1 } from '@vforsh/argus-plugin-api'
import { parseCsv } from './csv.js'
import { buildReadCsvExpression, type SheetCsvResult } from './sheetDataPageScripts.js'
import type { SheetResolveResult } from './pageScripts.js'
import { evalInWatcher, resolveSheetTarget, type Output, withSheetLease } from './sheetCommandUtils.js'

/** CLI read target flags shared by read/schema/query/diff. */
export type SheetReadTargetOptions = { gid?: string; sheet?: string }

/** Resolved target carried separately from browser current/restored state. */
export type ResolvedReadTarget = {
	name: string | null
	index: number | null
	gid: string | undefined
	targetUrl: string | null
	browserCurrentGid: string | null
	browserCurrentUrl: string | null
	browserRestoredGid: string | null
	browserRestoredUrl: string | null
}

/** CSV read result enriched with resolved target and restoration metadata. */
export type SheetCsvReadResult = SheetCsvResult & {
	targetSheet: string | null
	targetIndex: number | null
	browserRestoredGid: string | null
	browserRestoredUrl: string | null
}

/** Resolve mutually exclusive `--gid`/`--sheet` flags without losing target metadata. */
export const resolveReadTarget = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	options: SheetReadTargetOptions,
	output: Output,
): Promise<ResolvedReadTarget | null> => {
	if (options.gid && options.sheet) {
		output.writeWarn('Use only one sheet target: --gid or --sheet')
		process.exitCode = 2
		return null
	}
	if (!options.sheet) {
		return {
			name: null,
			index: null,
			gid: options.gid,
			targetUrl: null,
			browserCurrentGid: null,
			browserCurrentUrl: null,
			browserRestoredGid: null,
			browserRestoredUrl: null,
		}
	}
	const leased = await withSheetLease(
		ctx,
		id,
		output,
		{ operation: `resolve sheet ${options.sheet}`, restore: true },
		async () => await resolveSheetTarget(ctx, id, options.sheet as string, output),
	)
	const resolved: SheetResolveResult | null = leased?.value ?? null
	if (!resolved?.target.gid) return null
	return {
		name: resolved.target.name,
		index: resolved.target.index,
		gid: resolved.target.gid,
		targetUrl: resolved.target.url,
		browserCurrentGid: resolved.browser.currentGid,
		browserCurrentUrl: resolved.browser.currentUrl,
		browserRestoredGid: leased?.release?.browserCurrentGid ?? resolved.browser.restoredGid ?? null,
		browserRestoredUrl: leased?.release?.browserCurrentUrl ?? resolved.browser.restoredUrl ?? null,
	}
}

/** Read CSV from a resolved target and retain reliable target/browser metadata. */
export const readSheetCsv = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	options: SheetReadTargetOptions & { range?: string },
	output: Output,
): Promise<SheetCsvReadResult | null> => {
	const target = await resolveReadTarget(ctx, id, options, output)
	if (!target) return null
	const result = await evalInWatcher<SheetCsvResult>(ctx, id, buildReadCsvExpression({ range: options.range, gid: target.gid }), output)
	if (!result) return null
	return {
		...result,
		targetSheet: target.name,
		targetIndex: target.index,
		targetUrl: target.targetUrl ?? result.targetUrl,
		browserRestoredGid: target.browserRestoredGid,
		browserRestoredUrl: target.browserRestoredUrl,
	}
}

/** Read one exact physical row as CSV cells. */
export const readExactPhysicalRow = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	options: SheetReadTargetOptions & { row: number; lastColumn?: string },
	output: Output,
): Promise<{ values: string[]; data: SheetCsvReadResult; targetSheet: string | null } | null> => {
	const lastColumn = options.lastColumn ?? 'ZZZ'
	const data = await readSheetCsv(ctx, id, { ...options, range: `A${options.row}:${lastColumn}${options.row}` }, output)
	if (!data) return null
	return { values: parseCsv(data.csv)[0] ?? [], data, targetSheet: data.targetSheet }
}
