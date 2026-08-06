import type { ArgusPluginContextV1 } from '@vforsh/argus-plugin-api'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { formatA1Cell, parseA1Range } from './a1.js'
import {
	buildAcquireLeaseExpression,
	buildAssertLeaseExpression,
	buildReleaseLeaseExpression,
	buildRenewLeaseExpression,
	type SheetLeaseRelease,
	type SheetOperationLease,
} from './leasePageScripts.js'
import {
	buildResolveSheetExpression,
	buildSelectRangeExpression,
	buildSwitchSheetExpression,
	type SheetResolveResult,
	type SheetSelectResult,
	type SheetSwitchResult,
} from './pageScripts.js'

export type Output = ReturnType<ArgusPluginContextV1['host']['createOutput']>

/** Browser eval timeout profile. The page deadline must always be shorter than both values. */
export type SheetEvalOptions = { evalTimeoutMs?: number; requestTimeoutMs?: number }

/** Result of a callback protected by one page-scoped operation lease. */
export type SheetLeasedResult<T> = { value: T; lease: SheetOperationLease; release: SheetLeaseRelease | null }

const leasedExecution = new AsyncLocalStorage<{ indeterminate: boolean }>()

export const selectRange = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	range: string,
	output: Output,
): Promise<SheetSelectResult | null> => {
	const result = await evalInWatcher<SheetSelectResult>(ctx, id, buildSelectRangeExpression(range), output)
	if (!result) return null

	const selected = await dispatchKey(ctx, id, output, { key: 'Enter', selector: '#t-name-box' })
	if (!selected) return null

	await sleep(200)
	return result
}

/** Clear an exact rectangular cell range through native per-cell Backspace operations. */
export const clearGridRange = async (ctx: ArgusPluginContextV1, id: string | undefined, range: string, output: Output): Promise<boolean> => {
	const bounds = parseA1Range(range)
	if (!bounds) {
		output.writeWarn(`Expected an A1 cell range, got ${range}.`)
		process.exitCode = 2
		return false
	}
	for (let row = bounds.startRow; row <= bounds.endRow; row++) {
		for (let column = bounds.startColumn; column <= bounds.endColumn; column++) {
			const a1 = formatA1Cell(column, row, bounds.sheet)
			if (!(await selectRange(ctx, id, a1, output))) return false
			if (!(await dispatchKey(ctx, id, output, { key: 'Backspace' }))) return false
		}
	}
	await sleep(150)
	return true
}

export const resolveSheetTarget = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	target: string,
	output: Output,
): Promise<SheetResolveResult | null> => await evalInWatcher<SheetResolveResult>(ctx, id, buildResolveSheetExpression(target), output)

export const switchSheetTarget = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	target: string,
	output: Output,
): Promise<SheetSwitchResult | null> => await evalInWatcher<SheetSwitchResult>(ctx, id, buildSwitchSheetExpression(target), output)

export const dispatchKey = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	output: Output,
	body: { key: string; selector?: string; modifiers?: string },
): Promise<boolean> => {
	const response = await ctx.host.argus.dom.keydown(id, body, {
		timeoutMs: 30_000,
	})
	if (response.ok) return true

	markIndeterminateTimeout(response.message)
	ctx.host.writeRequestError(response, output)
	process.exitCode = response.exitCode
	return false
}

export const evalInWatcher = async <T>(
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	expression: string,
	output: Output,
	options: SheetEvalOptions = {},
): Promise<T | null> => {
	const evalTimeoutMs = clampTimeout(options.evalTimeoutMs ?? 30_000, 1_000, 120_000)
	const requestTimeoutMs = clampTimeout(options.requestTimeoutMs ?? evalTimeoutMs + 5_000, evalTimeoutMs + 1_000, 125_000)
	const response = await ctx.host.argus.eval(
		id,
		{
			expression,
			awaitPromise: true,
			returnByValue: true,
			timeoutMs: evalTimeoutMs,
		},
		{
			timeoutMs: requestTimeoutMs,
		},
	)
	if (!response.ok) {
		markIndeterminateTimeout(response.message)
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

/** Run a multi-call Google Sheets operation under a cross-process page lease and release it in `finally`. */
export const withSheetLease = async <T>(
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	output: Output,
	options: { operation: string; restore: boolean; ttlMs?: number },
	action: (lease: SheetOperationLease) => Promise<T>,
): Promise<SheetLeasedResult<T> | null> => {
	const ttlMs = clampTimeout(options.ttlMs ?? 60_000, 5_000, 300_000)
	const token = randomUUID()
	const lease = await evalInWatcher<SheetOperationLease>(
		ctx,
		id,
		buildAcquireLeaseExpression({ token, operation: options.operation, ttlMs }),
		output,
		{ evalTimeoutMs: 5_000, requestTimeoutMs: 8_000 },
	)
	if (!lease) return null
	let release: SheetLeaseRelease | null = null
	let value!: T
	const execution = { indeterminate: false }
	try {
		value = await leasedExecution.run(execution, async () => await action(lease))
	} finally {
		if (execution.indeterminate) {
			output.writeWarn(`Sheets operation timed out indeterminately; lease retained for at most ${ttlMs}ms to prevent overlapping UI work.`)
		} else {
			release = await evalInWatcher<SheetLeaseRelease>(ctx, id, buildReleaseLeaseExpression({ token, restore: options.restore }), output, {
				evalTimeoutMs: 5_000,
				requestTimeoutMs: 8_000,
			})
		}
	}
	return { value, lease, release }
}

/** Assert that an existing lease token is still current before a UI step. */
export const assertSheetLease = async (ctx: ArgusPluginContextV1, id: string | undefined, output: Output, token: string): Promise<boolean> =>
	Boolean(await evalInWatcher(ctx, id, buildAssertLeaseExpression(token), output, { evalTimeoutMs: 3_000, requestTimeoutMs: 5_000 }))

/** Renew a matching lease token for another bounded operation window. */
export const renewSheetLease = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	output: Output,
	token: string,
	ttlMs = 60_000,
): Promise<boolean> =>
	Boolean(
		await evalInWatcher(ctx, id, buildRenewLeaseExpression({ token, ttlMs }), output, {
			evalTimeoutMs: 3_000,
			requestTimeoutMs: 5_000,
		}),
	)

const clampTimeout = (value: number, minimum: number, maximum: number): number => Math.min(maximum, Math.max(minimum, Math.round(value)))

const markIndeterminateTimeout = (message: string): void => {
	if (/timed?\s*out|timeout/i.test(message)) {
		const execution = leasedExecution.getStore()
		if (execution) execution.indeterminate = true
	}
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
