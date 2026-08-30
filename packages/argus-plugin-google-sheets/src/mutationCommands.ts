import { readStdin, usageError } from './cliArgs.js'
import { failCommand } from './commandExit.js'
import { parseDurationMs } from '@vforsh/argus-core'
import type { Command } from 'commander'
import type { ArgusPluginContextV1 } from '@vforsh/argus-plugin-api'
import { loadBatchOperations, type BatchOperation } from './batchInput.js'
import { parseTsv, toTsv } from './csv.js'
import {
	buildPrepareWriteExpression,
	buildVerifyClearExpression,
	buildVerifyWriteExpression,
	type SheetCellMismatch,
	type SheetPreparedWriteResult,
	type SheetWriteVerificationResult,
} from './mutationPageScripts.js'
import type { SheetTab } from './pageScripts.js'
import { clearGridRange, dispatchKey, evalInWatcher, runSheetCommand, type Output, switchSheetTarget, withSheetLease } from './sheetCommandUtils.js'

type CommonOptions = {
	json?: boolean
	sheet?: string
}

type MutationMethod = 'auto' | 'ui'

type WriteOptions = CommonOptions & {
	value?: string
	tsv?: string
	stdin?: boolean
	strict?: boolean
	verify?: boolean
	verifyTimeout?: string
}

type ClearOptions = CommonOptions & {
	strict?: boolean
	method?: MutationMethod
	verifyTimeout?: string
}

type BatchOptions = CommonOptions & {
	file?: string
	stdin?: boolean
	strict?: boolean
	method?: MutationMethod
	verifyTimeout?: string
}

type MutationResult = {
	ok: true
	operation: 'write' | 'clear'
	range: string
	method: 'ui-paste' | 'ui-clear'
	sheet?: SheetTab
	verified: boolean | null
	verificationRange: string
	attempts: number
	mismatches: SheetCellMismatch[]
	verificationSkipped?: boolean
	rows?: number
}

const DEFAULT_VERIFY_TIMEOUT_MS = 1_500

export const registerSheetMutationCommands = (ctx: ArgusPluginContextV1, sheets: Command): void => {
	sheets
		.command('write')
		.argument('[id]', 'Watcher id for an attached Google Sheets tab')
		.argument('<range>', 'A1 range whose top-left cell receives the pasted content')
		.description('Paste a value or TSV block into a range in the open Google Sheets tab')
		.option('--value <text>', 'Single-cell value to paste')
		.option('--tsv <text>', 'TSV block to paste')
		.option('--stdin', 'Read TSV from stdin')
		.option('--strict', 'Deprecated compatibility flag; verification failures always exit non-zero')
		.option('--verify-timeout <duration>', 'Verification timeout, for example 500ms or 5s')
		.option('--sheet <nameOrGidOrIndex>', 'Visible sheet name, 1-based index, or gid')
		.option('--no-verify', 'Deprecated unsafe option; rejected')
		.option('--json', 'Output JSON for automation')
		.action(async (id: string | undefined, range: string, options: WriteOptions) => runWrite(ctx, id, range, options))

	sheets
		.command('clear')
		.argument('[id]', 'Watcher id for an attached Google Sheets tab')
		.argument('<range>', 'A1 range to clear')
		.description('Clear values from a range in the open Google Sheets tab')
		.option('--strict', 'Deprecated compatibility flag; verification failures always exit non-zero')
		.option('--verify-timeout <duration>', 'Verification timeout, for example 500ms or 5s')
		.option('--sheet <nameOrGidOrIndex>', 'Visible sheet name, 1-based index, or gid')
		.option('--method <auto|ui>', 'Mutation method (default: auto)')
		.option('--json', 'Output JSON for automation')
		.action(async (id: string | undefined, range: string, options: ClearOptions) => runClear(ctx, id, range, options))

	sheets
		.command('batch')
		.argument('[id]', 'Watcher id for an attached Google Sheets tab')
		.description('Apply a JSON batch of Google Sheets write and clear operations')
		.option('--file <path>', 'Read JSON batch from a file')
		.option('--stdin', 'Read JSON batch from stdin')
		.option('--strict', 'Deprecated compatibility flag; verification failures always exit non-zero')
		.option('--verify-timeout <duration>', 'Verification timeout per operation, for example 500ms or 5s')
		.option('--sheet <nameOrGidOrIndex>', 'Default visible sheet name, 1-based index, or gid for operations without a sheet')
		.option('--method <auto|ui>', 'Mutation method (default: auto)')
		.option('--json', 'Output JSON for automation')
		.action(async (id: string | undefined, options: BatchOptions) => runBatch(ctx, id, options))
}

const runWrite = (ctx: ArgusPluginContextV1, id: string | undefined, range: string, options: WriteOptions): Promise<void> =>
	runSheetCommand(ctx, id, options, {
		validate: (opts, output) => {
			const timeoutMs = resolveVerifyTimeout(opts, output)
			if (timeoutMs == null) return null
			if (opts.verify === false) {
				return usageError(output, '--no-verify is no longer supported; every mutation requires readback verification')
			}
			return timeoutMs
		},
		execute: async ({ output, validated: timeoutMs }) => {
			// stdin is only readable here: `validate` is synchronous by design.
			const tsv = await resolveWriteTsv(options)
			if (tsv == null) return usageError(output, 'Provide exactly one of --value, --tsv, or --stdin')
			if (tsv === '' || parseTsv(tsv).every((row) => row.every((cell) => cell === ''))) {
				return usageError(output, 'Empty writes are unsafe and rejected; use sheets clear or null in a version-1 apply manifest')
			}

			const leased = await withSheetLease(
				ctx,
				id,
				output,
				{ operation: `legacy write ${range}`, restore: true },
				async () =>
					await writeValuesOperation(ctx, id, output, {
						range,
						sheet: options.sheet,
						values: parseTsv(tsv),
						verify: true,
						timeoutMs,
					}),
			)
			return finishMutation(leased?.value ?? null)
		},
		formatJson: (result) => toWritePayload(result),
		formatHuman: (result, output) => {
			output.writeHuman(`Wrote ${result.rows ?? 0} row(s) into ${formatMutationTarget(result)} via ${result.method}`)
			writeVerificationSummary(output, result)
		},
	})

const runClear = (ctx: ArgusPluginContextV1, id: string | undefined, range: string, options: ClearOptions): Promise<void> =>
	runSheetCommand(ctx, id, options, {
		validate: (opts, output) => {
			const method = resolveMutationMethod(opts.method, output)
			if (!method) return null
			const timeoutMs = resolveVerifyTimeout(opts, output)
			return timeoutMs == null ? null : { method, timeoutMs }
		},
		execute: async ({ output, validated }) => {
			const leased = await withSheetLease(
				ctx,
				id,
				output,
				{ operation: `clear ${range}`, restore: true },
				async () =>
					await clearRangeOperation(ctx, id, output, {
						range,
						sheet: options.sheet,
						method: validated.method,
						verify: true,
						timeoutMs: validated.timeoutMs,
					}),
			)
			return finishMutation(leased?.value ?? null)
		},
		formatHuman: (result, output) => {
			output.writeHuman(`Cleared ${formatMutationTarget(result)} via ${result.method}`)
			writeVerificationSummary(output, result)
		},
	})

const runBatch = (ctx: ArgusPluginContextV1, id: string | undefined, options: BatchOptions): Promise<void> =>
	runSheetCommand(ctx, id, options, {
		validate: (opts, output) => {
			const method = resolveMutationMethod(opts.method, output)
			if (!method) return null
			const timeoutMs = resolveVerifyTimeout(opts, output)
			return timeoutMs == null ? null : { method, timeoutMs }
		},
		execute: async ({ output, validated }) => {
			const operations = await loadBatchOperations(options, output, readStdin)
			if (!operations) return null

			const leased = await withSheetLease(ctx, id, output, { operation: 'legacy batch', restore: true, ttlMs: 300_000 }, async () => {
				const results: MutationResult[] = []
				for (const operation of operations) {
					const result = await runBatchOperation(ctx, id, output, operation, {
						sheet: options.sheet,
						method: validated.method,
						timeoutMs: validated.timeoutMs,
					})
					if (!result) return null
					results.push(result)
				}
				return results
			})

			const results = leased?.value
			if (!results) return null
			if (results.some(didVerificationFail)) failCommand(1)
			return { ok: true as const, operations: results }
		},
		formatHuman: (result, output) => {
			for (const operation of result.operations) {
				const verb = operation.operation === 'write' ? `Wrote ${operation.rows ?? 0} row(s) into` : 'Cleared'
				output.writeHuman(`${verb} ${formatMutationTarget(operation)} via ${operation.method}`)
				writeVerificationSummary(output, operation)
			}
		},
	})

/** A mutation that ran but failed readback is still reported in full, with a non-zero exit code. */
const finishMutation = (result: MutationResult | null): MutationResult | null => {
	if (result && didVerificationFail(result)) failCommand(1)
	return result
}

const runBatchOperation = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	output: Output,
	operation: BatchOperation,
	options: { sheet?: string; method: MutationMethod; timeoutMs: number },
): Promise<MutationResult | null> => {
	const sheet = operation.sheet ?? options.sheet
	const verify = operation.verify !== false
	if ('values' in operation) {
		return await writeValuesOperation(ctx, id, output, {
			range: operation.range,
			sheet,
			values: operation.values,
			verify,
			timeoutMs: options.timeoutMs,
		})
	}

	return await clearRangeOperation(ctx, id, output, {
		range: operation.range,
		sheet,
		method: options.method,
		verify,
		timeoutMs: options.timeoutMs,
	})
}

const writeValuesOperation = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	output: Output,
	input: { range: string; sheet?: string; values: string[][]; verify: boolean; timeoutMs: number },
): Promise<MutationResult | null> => {
	const sheet = await switchToSheetTarget(ctx, id, output, input.sheet)
	if (sheet === false) return null

	const tsv = toTsv(input.values)
	const prepared = await prepareUiWrite(ctx, id, input.range, tsv, input.values, output)
	if (!prepared) return null

	const selected = await dispatchKey(ctx, id, output, { key: 'Enter', selector: '#t-name-box' })
	if (!selected) return null

	const pasted = await dispatchKey(ctx, id, output, { key: 'v', modifiers: 'ctrl' })
	if (!pasted) return null

	const verification = input.verify ? await verifyValues(ctx, id, output, prepared.verificationRange, input.values, input.timeoutMs) : null
	if (input.verify && !verification) return null

	return {
		ok: true,
		operation: 'write',
		range: prepared.range,
		method: prepared.method,
		sheet,
		rows: input.values.length,
		verificationRange: prepared.verificationRange,
		verified: verification?.verified ?? null,
		attempts: verification?.attempts ?? 0,
		mismatches: verification?.mismatches ?? [],
		verificationSkipped: !input.verify || undefined,
	}
}

const clearRangeOperation = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	output: Output,
	input: { range: string; sheet?: string; method: MutationMethod; verify: boolean; timeoutMs: number },
): Promise<MutationResult | null> => {
	const sheet = await switchToSheetTarget(ctx, id, output, input.sheet)
	if (sheet === false) return null

	if (!(await clearGridRange(ctx, id, input.range, output))) return null

	const verification = input.verify ? await verifyClear(ctx, id, output, input.range, input.timeoutMs) : null
	if (input.verify && !verification) return null

	return {
		ok: true,
		operation: 'clear',
		range: input.range,
		method: 'ui-clear',
		sheet,
		verificationRange: input.range,
		verified: verification?.verified ?? null,
		attempts: verification?.attempts ?? 0,
		mismatches: verification?.mismatches ?? [],
		verificationSkipped: !input.verify || undefined,
	}
}

const switchToSheetTarget = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	output: Output,
	sheet: string | undefined,
): Promise<SheetTab | undefined | false> => {
	if (!sheet) return undefined
	const result = await switchSheetTarget(ctx, id, sheet, output)
	return result?.sheet ?? false
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

const verifyValues = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	output: Output,
	range: string,
	expectedValues: string[][],
	timeoutMs: number,
): Promise<SheetWriteVerificationResult | null> =>
	await evalInWatcher<SheetWriteVerificationResult>(ctx, id, buildVerifyWriteExpression({ range, expectedValues, timeoutMs }), output)

const verifyClear = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	output: Output,
	range: string,
	timeoutMs: number,
): Promise<SheetWriteVerificationResult | null> =>
	await evalInWatcher<SheetWriteVerificationResult>(ctx, id, buildVerifyClearExpression({ range, timeoutMs }), output)

const resolveWriteTsv = async (options: WriteOptions): Promise<string | null> => {
	const selected = [options.value != null, options.tsv != null, options.stdin === true].filter(Boolean).length
	if (selected !== 1) return null
	if (options.value != null) return toTsv([[options.value]])
	if (options.tsv != null) return options.tsv
	return await readStdin()
}

const resolveMutationMethod = (value: string | undefined, output: Output): MutationMethod | null => {
	const method = value ?? 'auto'
	if (method === 'auto' || method === 'ui') return method

	return usageError(output, '--method must be auto or ui')
}

const resolveVerifyTimeout = (options: { verifyTimeout?: string }, output: Output): number | null => {
	const timeoutMs = parseTimeoutMs(options.verifyTimeout, DEFAULT_VERIFY_TIMEOUT_MS)
	if (timeoutMs != null) return timeoutMs

	return usageError(output, '--verify-timeout must be a positive duration such as 500ms or 5s')
}

/**
 * Parse a plugin timeout flag into whole milliseconds.
 *
 * Bare numbers mean milliseconds here (the flags document millisecond-scale examples),
 * unlike the CLI's second-defaulting duration flags. Returns `fallback` when the flag is
 * absent, and `null` when the value is malformed or not strictly positive.
 */
export const parseTimeoutMs = (value: string | undefined, fallback: number): number | null => {
	if (value == null) return fallback

	const ms = parseDurationMs(value, 'ms')
	return ms != null && ms > 0 ? Math.round(ms) : null
}

/** `write` reports `rows` as a number even when the operation carried none. */
const toWritePayload = (result: MutationResult) => ({
	ok: true,
	range: result.range,
	sheet: result.sheet,
	method: result.method,
	rows: result.rows ?? 0,
	verified: result.verified,
	verificationRange: result.verificationRange,
	attempts: result.attempts,
	mismatches: result.mismatches,
	verificationSkipped: result.verificationSkipped,
})

const writeVerificationSummary = (output: Output, result: MutationResult): void => {
	if (result.verificationSkipped) {
		output.writeHuman('Verification skipped')
		return
	}
	if (result.verified) return

	output.writeHuman(`Verification failed for ${formatVerificationTarget(result)} after ${result.attempts} attempt(s)`)
	if (result.mismatches.length > 0) output.writeHuman(`Mismatches:\n${formatMismatches(result.mismatches)}`)
}

const formatMismatches = (mismatches: SheetCellMismatch[]): string =>
	mismatches
		.map((mismatch) => `  ${mismatch.a1} expected ${JSON.stringify(mismatch.expected)} actual ${JSON.stringify(mismatch.actual)}`)
		.join('\n')

const formatMutationTarget = (result: MutationResult): string => (result.sheet ? `${result.sheet.name}!${result.range}` : result.range)

const formatVerificationTarget = (result: MutationResult): string =>
	result.sheet ? `${result.sheet.name}!${result.verificationRange}` : result.verificationRange

const didVerificationFail = (result: MutationResult): boolean => result.verified === false || result.mismatches.length > 0
