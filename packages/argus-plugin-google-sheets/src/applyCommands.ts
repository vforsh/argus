import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ArgusPluginContextV1 } from '@vforsh/argus-plugin-api'
import type { Command } from 'commander'
import { a1ForOffset } from './a1.js'
import { planSheetManifest, type ApplyPlan, type ApplyPlannerAdapter, type PlannedApplyStep, type PlannedSheetTarget } from './applyPlanner.js'
import { mutateDimensionOnce } from './dimensionCommands.js'
import { parseCsv } from './csv.js'
import { buildLocateRowsExpression, type ExactLocatorResult, type ExactRowMatch } from './locatorPageScripts.js'
import { parseSheetManifest, type SheetManifest, type SheetManifestOperation } from './manifest.js'
import { readTypedMatrixFromClipboard } from './rawCellValues.js'
import { buildSheetSchema } from './schema.js'
import { buildReadCsvExpression, type SheetCsvResult } from './sheetDataPageScripts.js'
import { evalInWatcher, renewSheetLease, switchSheetTarget, type Output, withSheetLease } from './sheetCommandUtils.js'
import { clearTypedRange, setTypedRange, type TypedMutationResult } from './typedMutationRuntime.js'
import { compareTypedMatrix, shiftedRawValueMatches, type RawCellValue } from './typedValues.js'

type ApplyOptions = {
	json?: boolean
	file?: string
	stdin?: boolean
	dryRun?: boolean
	yes?: boolean
	journal?: string
	rollback?: string
	maxRow?: string
}

type ApplyJournal = {
	version: 1
	nonAtomic: true
	status: 'planned' | 'complete' | 'partial' | 'failed'
	snapshot: ApplyPlan['snapshot']
	completedSteps: Array<{ index: number; operationIndex: number; op: PlannedApplyStep['op']; sheet: string; range: string; verified: boolean }>
	attemptedStep: { operationIndex: number; op: PlannedApplyStep['op']; sheet: string; range: string } | null
	failure: string | null
	rollbackUnavailable: Array<{ operationIndex: number; reason: string }>
}

/** Register the versioned, preconditioned, explicitly non-transactional apply command. */
export const registerSheetApplyCommand = (ctx: ArgusPluginContextV1, sheets: Command): void => {
	sheets
		.command('apply')
		.argument('[id]', 'Watcher id for an attached Google Sheets tab')
		.description('Preflight and sequentially apply a version-1 semantic mutation manifest')
		.option('--file <path>', 'Read manifest JSON from a file')
		.option('--stdin', 'Read manifest JSON from stdin')
		.option('--dry-run', 'Preflight only; show +/~/- without mutation')
		.option('--yes', 'Explicitly confirm non-interactive sequential mutation')
		.option('--journal <path>', 'Execution journal path (default: <file>.journal.json)')
		.option('--rollback <path>', 'Rollback manifest path (default: <file>.rollback.json)')
		.option('--max-row <n>', 'Maximum physical row scanned for semantic locators (default: 10000)', '10000')
		.option('--json', 'Output stable JSON for automation')
		.action(async (id: string | undefined, options: ApplyOptions) => runApply(ctx, id, options))
}

const runApply = async (ctx: ArgusPluginContextV1, id: string | undefined, options: ApplyOptions): Promise<void> => {
	const output = ctx.host.createOutput(options)
	if ([options.file != null, options.stdin === true].filter(Boolean).length !== 1)
		return usageError(output, 'Provide exactly one of --file or --stdin')
	if ([options.dryRun === true, options.yes === true].filter(Boolean).length !== 1)
		return usageError(output, 'Choose exactly one of --dry-run or --yes; mutation never proceeds without --yes')
	const maxRow = Number(options.maxRow)
	if (!Number.isInteger(maxRow) || maxRow < 1) return usageError(output, '--max-row must be a positive integer')
	const manifest = await loadManifest(options, output)
	if (!manifest) return
	const journalPath = resolve(options.journal ?? (options.file ? `${options.file}.journal.json` : 'sheets-apply.journal.json'))
	const rollbackPath = resolve(options.rollback ?? (options.file ? `${options.file}.rollback.json` : 'sheets-apply.rollback.json'))

	try {
		const leased = await withSheetLease(
			ctx,
			id,
			output,
			{ operation: options.dryRun ? 'sheets apply dry-run' : 'sheets apply', restore: true, ttlMs: 300_000 },
			async (lease) => {
				const adapter = createPlannerAdapter(ctx, id, output, maxRow)
				const plan = await planSheetManifest(manifest, adapter)
				if (options.dryRun) return { plan, execution: null }
				const execution = await executePlan(ctx, id, output, lease.token, plan, adapter, journalPath, rollbackPath)
				return { plan, execution }
			},
		)
		if (!leased) return
		const { plan, execution } = leased.value
		const payload = {
			ok: execution?.journal.status !== 'partial' && execution?.journal.status !== 'failed',
			dryRun: options.dryRun === true,
			nonAtomic: true,
			snapshot: plan.snapshot,
			steps: plan.steps.map(formatPlanStep),
			journal: execution ? journalPath : null,
			rollback: execution ? rollbackPath : null,
			status: execution?.journal.status ?? 'planned',
			browserRestoredUrl: leased.release?.browserCurrentUrl ?? null,
		}
		if (options.json) output.writeJson(payload)
		else writeApplyHuman(output, payload)
	} catch (error) {
		runtimeError(output, error instanceof Error ? error.message : String(error))
	}
}

const createPlannerAdapter = (ctx: ArgusPluginContextV1, id: string | undefined, output: Output, maxRow: number): ApplyPlannerAdapter => ({
	resolveSheet: async (sheet) => {
		const result = await switchSheetTarget(ctx, id, sheet, output)
		if (!result?.sheet.gid) throw new Error(`Could not resolve sheet ${JSON.stringify(sheet)}.`)
		return { name: result.sheet.name, gid: result.sheet.gid, url: result.url }
	},
	readSchema: async (target, headerRow) => {
		const result = await readCsvByTarget(ctx, id, output, target, `A${headerRow}:ZZZ${headerRow}`)
		return buildSheetSchema(parseCsv(result.csv)[0] ?? [], headerRow)
	},
	readExport: async (target) => parseCsv((await readCsvByTarget(ctx, id, output, target)).csv),
	locateRows: async (target, headerRow, width, candidates) => {
		const result = await evalInWatcher<ExactLocatorResult<ExactRowMatch>>(
			ctx,
			id,
			buildLocateRowsExpression({ gid: target.gid, startRow: headerRow + 1, maxRow, width, candidates, deadlineMs: 25_000 }),
			output,
			{ evalTimeoutMs: 27_000, requestTimeoutMs: 30_000 },
		)
		if (!result?.complete)
			throw new Error(`Exact semantic locator was incomplete (${result?.reason ?? 'transport failure'}); no mutation started.`)
		return new Map(result.matches.map((match) => [match.exportRow, match.sheetRow]))
	},
	readRaw: async (target, range, rows, columns) => {
		if (!(await switchSheetTarget(ctx, id, target.name, output))) throw new Error(`Could not activate ${target.name} for raw precondition.`)
		const result = await readTypedMatrixFromClipboard(ctx, id, output, { range, rows, columns })
		if (!result) throw new Error(`Raw Sheets copy precondition read failed for ${target.name}!${range}.`)
		return result
	},
})

const readCsvByTarget = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	output: Output,
	target: PlannedSheetTarget,
	range?: string,
): Promise<SheetCsvResult> => {
	const result = await evalInWatcher<SheetCsvResult>(ctx, id, buildReadCsvExpression({ gid: target.gid, range }), output)
	if (!result) throw new Error(`CSV read failed for ${target.name}${range ? `!${range}` : ''}.`)
	return result
}

const executePlan = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	output: Output,
	leaseToken: string,
	plan: ApplyPlan,
	adapter: ApplyPlannerAdapter,
	journalPath: string,
	rollbackPath: string,
): Promise<{ journal: ApplyJournal }> => {
	const journal: ApplyJournal = {
		version: 1,
		nonAtomic: true,
		status: 'failed',
		snapshot: plan.snapshot,
		completedSteps: [],
		attemptedStep: null,
		failure: null,
		rollbackUnavailable: [],
	}
	const completed: PlannedApplyStep[] = []
	let attempted: PlannedApplyStep | null = null
	try {
		for (let index = 0; index < plan.steps.length; index++) {
			const step = plan.steps[index]
			if (!(await renewSheetLease(ctx, id, output, leaseToken, 300_000))) throw new Error('Operation lease could not be renewed.')
			await recheckStep(adapter, step)
			attempted = step
			journal.attemptedStep = { operationIndex: step.operationIndex, op: step.op, sheet: step.target.name, range: step.range }
			const result = await executeStep(ctx, id, output, step)
			if (!result?.verified) {
				const mismatch = result?.mismatches[0]
				const detail = mismatch ? ` First mismatch ${mismatch.a1}: ${mismatch.reason}; actual=${JSON.stringify(mismatch.actual)}.` : ''
				throw new Error(`Mandatory verification failed for ${step.target.name}!${step.range}.${detail}`)
			}
			await verifyStepAfter(adapter, step)
			completed.push(step)
			attempted = null
			journal.attemptedStep = null
			journal.completedSteps.push({
				index,
				operationIndex: step.operationIndex,
				op: step.op,
				sheet: step.target.name,
				range: step.range,
				verified: true,
			})
			journal.status = 'partial'
			await persistJournal(journalPath, rollbackPath, journal, completed)
		}
		journal.status = 'complete'
		await persistJournal(journalPath, rollbackPath, journal, completed)
		return { journal }
	} catch (error) {
		journal.status = completed.length > 0 ? 'partial' : 'failed'
		journal.failure = error instanceof Error ? error.message : String(error)
		const rollbackSteps = attempted ? [...completed, await captureAttemptedState(adapter, attempted)] : completed
		await persistJournal(journalPath, rollbackPath, journal, rollbackSteps)
		throw new Error(`${journal.failure} Partial journal: ${journalPath}; rollback manifest: ${rollbackPath}.`)
	}
}

const captureAttemptedState = async (adapter: ApplyPlannerAdapter, step: PlannedApplyStep): Promise<PlannedApplyStep> => {
	if (step.op === 'deleteRows') return step
	try {
		const rows = step.before.length || step.after.length
		const columns = step.before[0]?.length || step.after[0]?.length
		const current = await adapter.readRaw(step.target, step.range, rows, columns)
		return { ...step, after: current.map((row) => row.map((cell) => (cell.formula ? { formula: cell.formula } : cell.value))) }
	} catch {
		return step
	}
}

const recheckStep = async (adapter: ApplyPlannerAdapter, step: PlannedApplyStep): Promise<void> => {
	if (step.before.length === 0) return
	const actual = await adapter.readRaw(step.target, step.range, step.before.length, step.before[0].length)
	const mismatches = compareTypedMatrix(step.range, actual, step.before)
	if (mismatches.length > 0) throw new Error(`State changed after preflight at ${mismatches[0].a1}; refusing operation ${step.operationIndex}.`)
}

const executeStep = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	output: Output,
	step: PlannedApplyStep,
): Promise<TypedMutationResult | null> => {
	if (step.op === 'setRange') return await setTypedRange(ctx, id, output, { sheet: step.target.name, range: step.range, values: step.after })
	if (step.op === 'clear') return await clearTypedRange(ctx, id, output, { sheet: step.target.name, range: step.range })
	if (!(await switchSheetTarget(ctx, id, step.target.name, output))) return null
	if (step.op === 'insertRows') {
		const inserted = await mutateDimensionOnce(ctx, id, output, {
			action: 'add',
			dimension: 'rows',
			index: step.row as number,
			count: step.count as number,
			side: 'before',
		})
		if (!inserted) return null
		return await setTypedRange(ctx, id, output, { sheet: step.target.name, range: `A${step.row}`, values: step.after })
	}
	const removed = await mutateDimensionOnce(ctx, id, output, {
		action: 'remove',
		dimension: 'rows',
		index: step.row as number,
		count: step.count as number,
	})
	return removed ? { ok: true, sheet: step.target.name, range: step.range, method: 'ui-clear', verified: true, mismatches: [] } : null
}

const verifyStepAfter = async (adapter: ApplyPlannerAdapter, step: PlannedApplyStep): Promise<void> => {
	if (step.after.length > 0) {
		const actual = await adapter.readRaw(step.target, step.range, step.after.length, step.after[0].length)
		const mismatches = compareTypedMatrix(step.range, actual, step.after)
		if (mismatches.length > 0) throw new Error(`Typed readback failed at ${mismatches[0].a1}: ${mismatches[0].reason}.`)
	}
	if (step.following) {
		const actual = await adapter.readRaw(step.target, step.following.range, step.following.before.length, step.following.before[0].length)
		const mismatch = firstShiftMismatch(step.following.range, actual, step.following.before)
		if (mismatch) throw new Error(`Structural shift verification failed at ${mismatch}.`)
	}
}

const firstShiftMismatch = (range: string, actual: RawCellValue[][], expected: RawCellValue[][]): string | null => {
	for (let row = 0; row < expected.length; row++) {
		for (let column = 0; column < expected[row].length; column++) {
			const before = expected[row][column]
			const after = actual[row]?.[column] ?? { value: null, formatted: null }
			if (!shiftedRawValueMatches(after, before)) return a1ForOffset(range, row, column)
		}
	}
	return null
}

const persistJournal = async (journalPath: string, rollbackPath: string, journal: ApplyJournal, completed: PlannedApplyStep[]): Promise<void> => {
	const rollback = buildRollbackManifest(completed, journal.rollbackUnavailable)
	await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, 'utf8')
	await writeFile(rollbackPath, `${JSON.stringify(rollback, null, 2)}\n`, 'utf8')
}

const buildRollbackManifest = (completed: PlannedApplyStep[], unavailable: ApplyJournal['rollbackUnavailable']): SheetManifest => {
	const operations: SheetManifestOperation[] = []
	for (const step of [...completed].reverse()) {
		if (step.op === 'deleteRows') {
			if (!unavailable.some((entry) => entry.operationIndex === step.operationIndex))
				unavailable.push({
					operationIndex: step.operationIndex,
					reason: 'Deleted-row structural reinsertion needs an explicit semantic anchor.',
				})
			continue
		}
		if (step.op === 'insertRows') {
			operations.push({ op: 'deleteRows', sheet: step.target.name, row: step.row as number, count: step.count as number, expect: step.after })
		} else {
			operations.push({ op: 'setRange', sheet: step.target.name, range: step.range, expect: step.after, values: step.before })
		}
	}
	return { version: 1, operations }
}

const loadManifest = async (options: ApplyOptions, output: Output): Promise<SheetManifest | null> => {
	try {
		const text = options.file ? await readFile(options.file, 'utf8') : await readStdin()
		const parsed = parseSheetManifest(JSON.parse(text) as unknown)
		if (typeof parsed === 'string') {
			usageError(output, parsed)
			return null
		}
		return parsed
	} catch (error) {
		usageError(output, `Failed to load manifest: ${error instanceof Error ? error.message : String(error)}`)
		return null
	}
}

const formatPlanStep = (step: PlannedApplyStep) => ({
	operationIndex: step.operationIndex,
	op: step.op,
	sheet: step.target.name,
	gid: step.target.gid,
	targetUrl: step.target.url,
	range: step.range,
	before: step.before,
	after: step.after,
})

const writeApplyHuman = (
	output: Output,
	payload: {
		dryRun: boolean
		nonAtomic: boolean
		status: string
		steps: ReturnType<typeof formatPlanStep>[]
		journal: string | null
		rollback: string | null
	},
): void => {
	output.writeHuman(`${payload.dryRun ? 'Dry-run' : 'Apply'} (${payload.nonAtomic ? 'sequential, non-atomic' : ''}): ${payload.status}`)
	for (const step of payload.steps) {
		const marker = step.op === 'insertRows' ? '+' : step.op === 'deleteRows' || step.op === 'clear' ? '-' : '~'
		output.writeHuman(`${marker} ${step.sheet}!${step.range}\t${JSON.stringify(step.before)} -> ${JSON.stringify(step.after)}`)
	}
	if (payload.journal) output.writeHuman(`Journal: ${payload.journal}`)
	if (payload.rollback) output.writeHuman(`Rollback manifest: ${payload.rollback}`)
}

const readStdin = async (): Promise<string> =>
	await new Promise((resolveText, reject) => {
		let data = ''
		process.stdin.setEncoding('utf8')
		process.stdin.on('data', (chunk) => (data += chunk))
		process.stdin.on('end', () => resolveText(data))
		process.stdin.on('error', reject)
		process.stdin.resume()
	})
const usageError = (output: Output, message: string): void => {
	output.writeWarn(message)
	process.exitCode = 2
}
const runtimeError = (output: Output, message: string): void => {
	output.writeWarn(message)
	process.exitCode = 1
}
