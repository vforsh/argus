import type { ArgusPluginContextV1 } from '@vforsh/argus-plugin-api'
import { failCommand } from './commandExit.js'
import { delay } from '@vforsh/argus-core'
import { expandA1RangeForShape, parseA1Range } from './a1.js'
import { expectationFormulaPredicate } from './applyPlanner.js'
import { buildTypedClipboardPayload } from './typedClipboard.js'
import { readTypedMatrix } from './rawCellValues.js'
import { dispatchKey, evalInWatcher, selectRange, switchSheetTarget, type Output } from './sheetCommandUtils.js'
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
	if (input.values.every((row) => row.every((value) => value === null))) {
		const range = expandA1RangeForShape(input.range, input.values.length, input.values[0].length)
		return await clearTypedRange(ctx, id, output, { sheet: input.sheet, range })
	}
	if (!(await switchSheetTarget(ctx, id, input.sheet, output))) return null
	const payload = buildTypedClipboardPayload(input.values)
	const prepared = await evalInWatcher<TypedWritePreparation>(ctx, id, buildPrepareTypedWriteExpression({ range: input.range, payload }), output)
	if (!prepared) return null
	if (!(await dispatchKey(ctx, id, output, { key: 'Enter', selector: '#t-name-box' }))) return null
	// The watcher dispatches CDP keyboard modifiers, so Sheets expects Ctrl even when
	// the CLI process itself runs on macOS. Meta produces a successful no-op.
	if (!(await dispatchKey(ctx, id, output, { key: 'v', modifiers: 'ctrl' }))) return null
	await delay(300)
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

/**
 * Execute one native clear over the whole selection and require an exact empty raw readback.
 *
 * Two round trips regardless of size: one selection plus `Delete`, then one rectangle copy. The
 * readback is raw rather than CSV on purpose -- CSV renders `=""` and an error cell as empty text,
 * so a formula the clear failed to remove would read back as a successful clear.
 */
export const clearTypedRange = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	output: Output,
	input: { sheet: string; range: string },
): Promise<TypedMutationResult | null> => {
	const bounds = parseA1Range(input.range)
	if (!bounds) throw new Error(`Expected an A1 cell range to clear, got ${input.range}.`)
	if (!(await switchSheetTarget(ctx, id, input.sheet, output))) return null
	if (!(await selectRange(ctx, id, input.range, output))) return null
	if (!(await dispatchKey(ctx, id, output, { key: 'Delete' }))) return null
	await delay(200)

	const rows = bounds.endRow - bounds.startRow + 1
	const columns = bounds.endColumn - bounds.startColumn + 1
	const expected = Array.from({ length: rows }, () => Array<CellValue>(columns).fill(null))
	const mismatches = await verifyTypedRange(ctx, id, output, input.range, expected)
	if (!mismatches) return null
	if (mismatches.length > 0) failCommand(1)
	return { ok: true, sheet: input.sheet, range: input.range, method: 'ui-clear', verified: mismatches.length === 0, mismatches }
}

const verifyTypedRange = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	output: Output,
	range: string,
	expected: CellValue[][],
): Promise<TypedMismatch[] | null> => {
	const actual = await readTypedMatrix(ctx, id, output, {
		range,
		rows: expected.length,
		columns: expected[0].length,
		resolveFormulaSources: expectationFormulaPredicate(expected),
	})
	return actual ? compareTypedMatrix(range, actual, expected) : null
}
