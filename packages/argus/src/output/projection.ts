import { parsePositiveInt } from '../cli/parse.js'
import type { Output } from './io.js'

/**
 * `--fields` / `--max-chars`: agent-facing output shaping shared by `eval`, `logs`, and `net`.
 *
 * Agents piped roughly a third of Argus output through `head`/`tail`/`cut`, which breaks JSON
 * mid-document and hides how much was cut. These helpers project records to the fields a caller
 * asked for and cap output size while keeping JSON valid and naming what was dropped.
 *
 * `--out` files are intentionally not shaped: they stay the full-fidelity escape hatch.
 */

/** Raw CLI values for `outputShapingOptions` (declared in `cli/register/sharedOptions.ts`). */
export type OutputShapingOptions = {
	fields?: string
	maxChars?: string
}

/** Parsed form of {@link OutputShapingOptions}. */
export type OutputShaping = {
	/** Field tree built from `--fields`; `undefined` keeps records whole. */
	fields?: FieldTree
	/** Character budget from `--max-chars`; `undefined` means unlimited. */
	maxChars?: number
}

/** Nested field selection. A `true` leaf keeps the whole value at that path. */
export type FieldTree = { [key: string]: FieldTree | true }

/**
 * Parse `--fields` / `--max-chars`.
 *
 * @returns The parsed shaping, or `null` after writing a warning and setting exit code 2.
 */
export const parseOutputShaping = (options: OutputShapingOptions, output: Output): OutputShaping | null => {
	const fields = parseFieldTree(options.fields)
	if (fields.error) return rejectShaping(fields.error, output)

	if (options.maxChars === undefined) return { fields: fields.value }

	const maxChars = parsePositiveInt(options.maxChars)
	if (maxChars === undefined) return rejectShaping('Invalid --max-chars value: expected a positive integer.', output)

	return { fields: fields.value, maxChars }
}

const rejectShaping = (message: string, output: Output): null => {
	output.writeWarn(message)
	process.exitCode = 2
	return null
}

/** `a,b.c,b.d` → `{ a: true, b: { c: true, d: true } }`. A shorter path wins over a longer one below it. */
const parseFieldTree = (value: string | undefined): { value?: FieldTree; error?: string } => {
	if (value === undefined) return {}

	const paths = value
		.split(',')
		.map((path) => path.trim())
		.filter((path) => path !== '')
	const invalid = 'Invalid --fields value: expected comma-separated dot paths like id,url,status or user.name.'
	if (paths.length === 0) return { error: invalid }

	const tree = emptyRecord<FieldTree | true>()
	for (const path of paths) {
		const segments = path.split('.')
		if (segments.some((segment) => segment.trim() === '')) return { error: invalid }
		addFieldPath(tree, segments.map((segment) => segment.trim()))
	}
	return { value: tree }
}

const addFieldPath = (tree: FieldTree, segments: string[]): void => {
	let node = tree
	for (const [index, segment] of segments.entries()) {
		const existing = Object.hasOwn(node, segment) ? node[segment] : undefined
		if (existing === true) return
		if (index === segments.length - 1) {
			node[segment] = true
			return
		}
		const child = existing ?? emptyRecord<FieldTree | true>()
		node[segment] = child
		node = child
	}
}

/**
 * Prototype-free dictionary for user-named keys.
 *
 * `--fields` keys come from the command line: on a plain `{}`, `constructor.name` walked into
 * `Object` and crashed on its read-only `name`, and `__proto__.x` wrote onto `Object.prototype`
 * for the rest of the process. Without a prototype both are ordinary own keys.
 */
const emptyRecord = <T>(): Record<string, T> => Object.create(null) as Record<string, T>

const MISSING = Symbol('missing-field')

/**
 * Project a value through a field tree.
 *
 * Objects keep only selected keys (missing paths are omitted); arrays project each element, at
 * the top level and mid-path (`items.name` over `{ items: [...] }`). Primitives at the top level
 * pass through unchanged, since there is nothing to select from.
 */
export const projectFields = (value: unknown, fields: FieldTree | undefined): unknown => {
	if (!fields || value === null || typeof value !== 'object') return value
	const projected = projectNode(value, fields)
	return projected === MISSING ? value : projected
}

const projectNode = (value: unknown, tree: FieldTree): unknown => {
	if (Array.isArray(value)) {
		return value.map((item) => projectNode(item, tree)).filter((item) => item !== MISSING)
	}
	if (value === null || typeof value !== 'object') return MISSING

	const source = value as Record<string, unknown>
	const result = emptyRecord<unknown>()
	for (const [key, sub] of Object.entries(tree)) {
		if (!Object.hasOwn(source, key)) continue
		const picked = sub === true ? source[key] : projectNode(source[key], sub)
		if (picked !== MISSING) result[key] = picked
	}
	return result
}

/** Marker appended to truncated human output. */
const truncationMarker = (detail: string): string => `… [truncated ${detail}; raise --max-chars]`

/** Cap human text at `maxChars`, appending an explicit marker line when anything was cut. */
export const truncateText = (text: string, maxChars: number | undefined): string => {
	if (maxChars === undefined || text.length <= maxChars) return text
	return `${text.slice(0, maxChars)}\n${truncationMarker(`${text.length - maxChars} chars`)}`
}

/**
 * Cap a JSON value at `maxChars` serialized characters.
 *
 * Over budget, the value becomes its serialized prefix (a string), so the surrounding document
 * stays valid JSON and the caller can still see the shape of what was there.
 */
export const truncateJsonValue = (
	value: unknown,
	maxChars: number | undefined,
): { value: unknown; truncated: false } | { value: string; truncated: true; totalChars: number } => {
	if (maxChars === undefined) return { value, truncated: false }
	// Strings are cut as text; serializing first would leave a stray leading quote and escapes.
	if (typeof value === 'string') {
		return value.length <= maxChars ? { value, truncated: false } : { value: value.slice(0, maxChars), truncated: true, totalChars: value.length }
	}
	const serialized = JSON.stringify(value) ?? ''
	if (serialized.length <= maxChars) return { value, truncated: false }
	return { value: serialized.slice(0, maxChars), truncated: true, totalChars: serialized.length }
}

/** Result of fitting a record list into a character budget. */
export type BudgetedRecords<T> = {
	records: T[]
	truncated: boolean
	/** Records dropped because the budget ran out. */
	omitted: number
}

/**
 * Keep leading records while their cost fits `maxChars`, in output order (like `head`).
 *
 * `cost` is the record's rendered size (a JSON serialization or a human line), plus one for the
 * separator. A first record over budget yields zero records: the cap is a promise, not a hint.
 */
export const takeWithinBudget = <T>(records: readonly T[], maxChars: number | undefined, cost: (record: T) => number): BudgetedRecords<T> => {
	if (maxChars === undefined) return { records: [...records], truncated: false, omitted: 0 }

	let used = 0
	let kept = 0
	for (const record of records) {
		const next = used + cost(record) + 1
		if (next > maxChars) break
		used = next
		kept += 1
	}
	return { records: records.slice(0, kept), truncated: kept < records.length, omitted: records.length - kept }
}

/**
 * Shape a record list for `--json`.
 *
 * Without `--max-chars` the output stays the command's plain array. With it, the output is always
 * `{ [key]: [...], truncated, omitted }`, whether or not anything was cut, so consumers read one
 * shape per invocation instead of branching on whether the budget happened to run out.
 */
export const shapeJsonRecords = (records: readonly unknown[], key: string, shaping: OutputShaping): unknown => {
	const projected = records.map((record) => projectFields(record, shaping.fields))
	if (shaping.maxChars === undefined) return projected

	const budgeted = takeWithinBudget(projected, shaping.maxChars, (record) => (JSON.stringify(record) ?? '').length)
	return { [key]: budgeted.records, truncated: budgeted.truncated, omitted: budgeted.omitted }
}

/**
 * Write a record list in human mode.
 *
 * With `--fields`, each record prints as one compact JSON line of the selected fields, since the
 * command's own formatter cannot render arbitrary paths. With `--max-chars`, lines stop once the
 * budget is spent and a marker line names how many records were dropped.
 */
export const writeHumanRecords = <T>(records: readonly T[], shaping: OutputShaping, format: (record: T) => string, output: Output): void => {
	const lines = records.map((record) => (shaping.fields ? JSON.stringify(projectFields(record, shaping.fields)) : format(record)))
	const budgeted = takeWithinBudget(lines, shaping.maxChars, (line) => line.length)
	for (const line of budgeted.records) {
		output.writeHuman(line)
	}
	if (budgeted.truncated) {
		output.writeHuman(truncationMarker(`${budgeted.omitted} of ${records.length} records`))
	}
}
