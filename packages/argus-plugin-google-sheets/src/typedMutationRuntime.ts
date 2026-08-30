import type { ArgusPluginContextV1 } from '@vforsh/argus-plugin-api'
import { failCommand } from './commandExit.js'
import { a1ForOffset } from './a1.js'
import { buildTypedClipboardPayload } from './typedClipboard.js'
import { buildVerifyClearExpression, type SheetWriteVerificationResult } from './mutationPageScripts.js'
import { readTypedMatrixFromClipboard } from './rawCellValues.js'
import { clearGridRange, dispatchKey, evalInWatcher, selectRange, sleep, switchSheetTarget, type Output } from './sheetCommandUtils.js'
import { buildPrepareTypedWriteExpression, type TypedWritePreparation } from './typedMutationPageScripts.js'
import { compareTypedMatrix, type CellValue, type TypedMismatch } from './typedValues.js'

/** Verified typed mutation result used by apply/journal output. */
export type TypedMutationResult = {
	ok: true
	sheet: string
	range: string
	method: 'ui-typed-paste' | 'ui-clear'
	verified: boolean
	mismatches: TypedMismatch[]
}

/** Execute one typed rectangular set and require raw typed/formula-source verification. */
export const setTypedRange = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	output: Output,
	input: { sheet: string; range: string; values: CellValue[][] },
): Promise<TypedMutationResult | null> => {
	if (input.values.every((row) => row.every((value) => value === null))) return await clearTypedRange(ctx, id, output, input)
	if (!(await switchSheetTarget(ctx, id, input.sheet, output))) return null
	const payload = buildTypedClipboardPayload(input.values)
	const prepared = await evalInWatcher<TypedWritePreparation>(ctx, id, buildPrepareTypedWriteExpression({ range: input.range, payload }), output)
	if (!prepared) return null
	if (!(await dispatchKey(ctx, id, output, { key: 'Enter', selector: '#t-name-box' }))) return null
	// The watcher dispatches CDP keyboard modifiers, so Sheets expects Ctrl even when
	// the CLI process itself runs on macOS. Meta produces a successful no-op.
	if (!(await dispatchKey(ctx, id, output, { key: 'v', modifiers: 'ctrl' }))) return null
	await sleep(300)
	if (!(await materializeDecimalNumbers(ctx, id, output, input.range, input.values))) return null
	const verification = await verifyTypedRange(ctx, id, output, prepared.verificationRange, input.values)
	if (!verification) return null
	if (verification.length > 0) failCommand(1)
	return {
		ok: true,
		sheet: input.sheet,
		range: prepared.verificationRange,
		method: 'ui-typed-paste',
		verified: verification.length === 0,
		mismatches: verification,
	}
}

const materializeDecimalNumbers = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	output: Output,
	range: string,
	values: CellValue[][],
): Promise<boolean> => {
	for (let row = 0; row < values.length; row++) {
		for (let column = 0; column < values[row].length; column++) {
			const value = values[row][column]
			if (typeof value !== 'number' || Number.isInteger(value)) continue
			const a1 = a1ForOffset(range, row, column)
			if (!(await selectRange(ctx, id, a1, output))) return false
			if (!(await dispatchKey(ctx, id, output, { key: 'c', modifiers: 'ctrl' }))) return false
			await sleep(150)
			const pasteValuesModifiers = process.platform === 'darwin' ? 'meta,shift' : 'ctrl,shift'
			if (!(await dispatchKey(ctx, id, output, { key: 'v', modifiers: pasteValuesModifiers }))) return false
			await sleep(200)
		}
	}
	return true
}

/** Execute one native clear and require exact empty readback. */
export const clearTypedRange = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	output: Output,
	input: { sheet: string; range: string },
): Promise<TypedMutationResult | null> => {
	if (!(await switchSheetTarget(ctx, id, input.sheet, output))) return null
	if (!(await clearGridRange(ctx, id, input.range, output))) return null
	const verification = await evalInWatcher<SheetWriteVerificationResult>(
		ctx,
		id,
		buildVerifyClearExpression({ range: input.range, timeoutMs: 2_000 }),
		output,
	)
	if (!verification) return null
	const mismatches: TypedMismatch[] = verification.mismatches.map((mismatch) => ({
		a1: mismatch.a1,
		expected: null,
		actual: { value: mismatch.actual, formatted: mismatch.actual },
		reason: 'expected clear',
	}))
	if (!verification.verified) failCommand(1)
	return { ok: true, sheet: input.sheet, range: input.range, method: 'ui-clear', verified: verification.verified, mismatches }
}

const verifyTypedRange = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	output: Output,
	range: string,
	expected: CellValue[][],
): Promise<TypedMismatch[] | null> => {
	const actual = await readTypedMatrixFromClipboard(ctx, id, output, {
		range,
		rows: expected.length,
		columns: expected[0].length,
	})
	return actual ? compareTypedMatrix(range, actual, expected) : null
}
