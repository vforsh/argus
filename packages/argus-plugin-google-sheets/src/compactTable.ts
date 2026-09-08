/**
 * Decoder for Google Sheets' `application/x-vnd.google-spreadsheet-compact-table+json` clipboard
 * payload, which one UI copy of a rectangle returns for every cell at once — geometry preserved,
 * blank cells included.
 *
 * The decoder is strict on purpose: a payload whose shape drifted throws instead of guessing, so a
 * Sheets change surfaces as a loud read failure rather than a silently wrong verification. Re-record
 * the fixtures under `test/fixtures/compact/` with `bun run capture-compact` when that happens.
 */

/** One decoded cell. `value` is the raw typed value; `error` carries the error label instead. */
export type CompactCell = {
	value: string | number | boolean | null
	formatted: string | null
	hasFormula: boolean
	error: string | null
}

/** Bit 0 of a cell flag: the cell contributes an entry to the typed value streams. */
const VALUE_BIT = 1
/** Bit 3 of a cell flag: the cell contributes an entry to the formula index stream. */
const FORMULA_BIT = 8

/**
 * Decode one copied rectangle into a row-major matrix of typed cells.
 *
 * @param input `compact` is the compact-table MIME string, `text` the `text/plain` TSV of the same
 * copy. The TSV only supplies `formatted` (and the error label); a shape mismatch degrades those
 * fields rather than failing the read.
 * @throws When the payload's own internal counts disagree — geometry, flag stream, value streams,
 * or formula stream.
 */
export const parseCompactTable = (input: { compact: string; text: string }): CompactCell[][] => {
	const payload = parsePayload(input.compact)
	const geometry = readGeometry(payload)
	const flags = decodeRunLength(readIntegerArray(payload['2'], 'cell flag stream'))
	if (flags.length !== geometry.total) throw drift(`flag stream expanded to ${flags.length} cells, expected ${geometry.total}`)

	const values = readValueStreams(payload)
	verifyFormulaStream(payload, flags.filter((flag) => (flag & FORMULA_BIT) !== 0).length)
	const formatted = readFormattedGrid(input.text, geometry)

	const cells: CompactCell[][] = []
	for (let row = 0; row < geometry.rows; row++) {
		const line: CompactCell[] = []
		for (let column = 0; column < geometry.columns; column++) {
			const flag = flags[row * geometry.columns + column]
			const cell = readCell(values, flag, formatted?.[row]?.[column] ?? null)
			// Without a usable TSV there is no locale-formatted text to report, only the value itself.
			line.push(formatted ? cell : { ...cell, formatted: cell.value == null ? null : String(cell.value) })
		}
		cells.push(line)
	}
	values.assertExhausted()
	return cells
}

/**
 * Expand Sheets' run-length encoding: a negative `-n` repeats the next entry `n` times, any other
 * entry stands for itself.
 *
 * Safe to run over a stream that is not encoded — a plain list of non-negative integers decodes to
 * itself — which is why the type stream goes through it too.
 */
export const decodeRunLength = (stream: readonly number[]): number[] => {
	const values: number[] = []
	for (let index = 0; index < stream.length; index++) {
		const entry = stream[index]
		if (entry >= 0) {
			values.push(entry)
			continue
		}
		const repeated = stream[index + 1]
		if (repeated == null || repeated < 0) throw drift(`run-length repeat of ${-entry} at index ${index} has no value to repeat`)
		for (let count = 0; count < -entry; count++) values.push(repeated)
		index++
	}
	return values
}

type CompactGeometry = { rows: number; columns: number; total: number }

const readGeometry = (payload: Record<string, unknown>): CompactGeometry => {
	const shape = payload['15']
	if (!isRecord(shape)) throw drift('key "15" (geometry) is missing')
	const rows = shape['1']
	const columns = shape['2']
	if (!isPositiveInteger(rows) || !isPositiveInteger(columns)) throw drift(`geometry is ${JSON.stringify(shape)}`)
	const total = payload['20']
	if (!isPositiveInteger(total)) throw drift(`key "20" (cell count) is ${JSON.stringify(total)}`)
	if (rows * columns !== total) throw drift(`geometry ${rows}x${columns} does not match cell count ${total}`)
	return { rows, columns, total }
}

/**
 * Cursors over the four parallel typed-value streams.
 *
 * `"3"."1"` holds one type per valued cell; the value itself comes from the list for that type, in
 * cell order. Reading is destructive so {@link ValueStreams.assertExhausted} can prove every list
 * was consumed exactly.
 */
type ValueStreams = {
	nextType: () => number
	nextNumber: () => number
	nextString: () => string
	nextStructured: () => Record<string, unknown>
	assertExhausted: () => void
}

const readValueStreams = (payload: Record<string, unknown>): ValueStreams => {
	const streams = payload['3'] ?? {}
	if (!isRecord(streams)) throw drift(`key "3" (typed values) is ${JSON.stringify(streams)}`)
	// Sheets omits a stream entirely when no cell needs it, so absent and empty mean the same thing.
	const types = decodeRunLength(readIntegerArray(streams['1'] ?? [], 'type stream'))
	const numbers = readArray(streams['3'] ?? [], 'number stream')
	const strings = readArray(streams['4'] ?? [], 'string stream')
	const structured = readArray(streams['5'] ?? [], 'structured stream')
	let typeCursor = 0
	let numberCursor = 0
	let stringCursor = 0
	let structuredCursor = 0
	return {
		nextType: () => {
			if (typeCursor >= types.length) throw drift(`type stream holds ${types.length} entries, fewer than the flag stream requires`)
			return types[typeCursor++]
		},
		nextNumber: () => {
			const value = numbers[numberCursor++]
			if (typeof value !== 'number' || !Number.isFinite(value))
				throw drift(`number stream entry ${numberCursor - 1} is ${JSON.stringify(value)}`)
			return value
		},
		nextString: () => {
			const value = strings[stringCursor++]
			if (typeof value !== 'string') throw drift(`string stream entry ${stringCursor - 1} is ${JSON.stringify(value)}`)
			return value
		},
		nextStructured: () => {
			const value = structured[structuredCursor++]
			if (!isRecord(value)) throw drift(`structured stream entry ${structuredCursor - 1} is ${JSON.stringify(value)}`)
			return value
		},
		assertExhausted: () => {
			if (typeCursor !== types.length) throw drift(`type stream has ${types.length - typeCursor} unconsumed entries`)
			if (numberCursor !== numbers.length) throw drift(`number stream has ${numbers.length - numberCursor} unconsumed entries`)
			if (stringCursor !== strings.length) throw drift(`string stream has ${strings.length - stringCursor} unconsumed entries`)
			if (structuredCursor !== structured.length)
				throw drift(`structured stream has ${structured.length - structuredCursor} unconsumed entries`)
		},
	}
}

const readCell = (values: ValueStreams, flag: number, text: string | null): CompactCell => {
	const hasFormula = (flag & FORMULA_BIT) !== 0
	const formatted = text === '' ? null : text
	if ((flag & VALUE_BIT) === 0) return { value: null, formatted, hasFormula, error: null }
	const type = values.nextType()
	// 1 number, 2 text, 3 structured (boolean or error), 4 text forced by an apostrophe prefix.
	if (type === 1) return { value: values.nextNumber(), formatted, hasFormula, error: null }
	if (type === 2 || type === 4) return { value: values.nextString(), formatted, hasFormula, error: null }
	if (type !== 3) throw drift(`unsupported value type ${type}`)
	return readStructuredCell(values.nextStructured(), formatted, hasFormula, text)
}

const readStructuredCell = (structured: Record<string, unknown>, formatted: string | null, hasFormula: boolean, text: string | null): CompactCell => {
	const kind = structured['1']
	// 4 is a boolean; 5 is an error, whose code table is undocumented -- the TSV label is authoritative.
	if (kind === 4) {
		const encoded = structured['4']
		if (encoded !== 0 && encoded !== 1) throw drift(`boolean entry is ${JSON.stringify(structured)}`)
		return { value: encoded === 1, formatted, hasFormula, error: null }
	}
	if (kind === 5) return { value: null, formatted, hasFormula, error: text || '#ERROR!' }
	throw drift(`structured entry is ${JSON.stringify(structured)}`)
}

/** Prove the formula index stream describes exactly the cells whose flag claimed a formula. */
const verifyFormulaStream = (payload: Record<string, unknown>, expected: number): void => {
	const formulas = readArray(payload['8'] ?? [], 'formula list')
	const indexes = decodeRunLength(readIntegerArray(payload['9'] ?? [], 'formula index stream'))
	if (indexes.length !== expected) throw drift(`formula index stream expanded to ${indexes.length} entries, expected ${expected}`)
	for (const index of indexes) {
		if (index >= formulas.length) throw drift(`formula index ${index} is outside the ${formulas.length}-entry formula list`)
	}
}

/**
 * Parse the `text/plain` TSV that accompanies the copy, or `null` when its shape disagrees with the
 * payload geometry.
 *
 * Only `formatted` and error labels depend on it, so a mismatch degrades those fields instead of
 * failing the whole read.
 */
const readFormattedGrid = (text: string, geometry: CompactGeometry): string[][] | null => {
	const grid = parseTsvGrid(text)
	if (grid.length !== geometry.rows) return null
	return grid.every((row) => row.length === geometry.columns) ? grid : null
}

/** Split Sheets' TSV: `"` quotes a field, `""` escapes a quote, tabs and newlines delimit. */
const parseTsvGrid = (text: string): string[][] => {
	const rows: string[][] = []
	let row: string[] = []
	let field = ''
	let quoted = false
	for (let index = 0; index < text.length; index++) {
		const character = text[index]
		if (quoted) {
			if (character !== '"') {
				field += character
			} else if (text[index + 1] === '"') {
				field += '"'
				index++
			} else {
				quoted = false
			}
			continue
		}
		if (character === '"' && field === '') quoted = true
		else if (character === '\t') {
			row.push(field)
			field = ''
		} else if (character === '\n') {
			row.push(field)
			rows.push(row)
			row = []
			field = ''
		} else if (character !== '\r') field += character
	}
	row.push(field)
	rows.push(row)
	// A trailing newline yields one spurious single-empty row; a genuinely blank last row is wider.
	if (rows.length > 1 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop()
	return rows
}

const parsePayload = (compact: string): Record<string, unknown> => {
	let payload: unknown
	try {
		payload = JSON.parse(compact)
	} catch {
		throw drift('copy did not provide valid compact-table JSON')
	}
	if (!isRecord(payload)) throw drift(`top level is ${JSON.stringify(payload)}`)
	return payload
}

const readArray = (value: unknown, label: string): unknown[] => {
	if (!Array.isArray(value)) throw drift(`${label} is ${JSON.stringify(value)}`)
	return value
}

const readIntegerArray = (value: unknown, label: string): number[] => {
	const entries = readArray(value, label)
	for (const entry of entries) if (!Number.isInteger(entry)) throw drift(`${label} holds ${JSON.stringify(entry)}`)
	return entries as number[]
}

const drift = (detail: string): Error => new Error(`Google Sheets compact-table payload changed shape: ${detail}.`)
const isPositiveInteger = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
