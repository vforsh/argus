import { indexToColumnLetters } from './a1.js'
import { resolveHeader, type SheetHeader, type SheetSchema } from './schema.js'

/** Supported query predicate. */
export type QueryPredicate =
	| { header: SheetHeader; operator: 'equals'; value: string }
	| { header: SheetHeader; operator: 'in'; values: string[] }
	| { header: SheetHeader; operator: 'substring'; value: string }
	| { header: SheetHeader; operator: 'regex'; source: string; flags: string }

/** Export candidate without fabricated physical coordinates. */
export type ExportRowCandidate = {
	exportRow: number
	values: string[]
}

/** Authoritatively located export candidate. */
export type LocatedRowCandidate = ExportRowCandidate & {
	sheetRow: number
	a1: string
	exactVerified: true
}

/** Parse a deterministic `--where` expression against a known schema. */
export const parseWhereExpression = (input: string, schema: SheetSchema): QueryPredicate | string => {
	const match = input.match(/^(.+?)\s+(equals|in|contains|substring|regex)\s+([\s\S]+)$/i) ?? input.match(/^(.+?)\s*=\s*([\s\S]+)$/)
	if (!match) return 'Invalid --where expression. Use <header> equals <value>, in [...], contains <value>, or regex /.../.'
	const header = resolveHeader(schema, match[1])
	if (typeof header === 'string') return header
	let rawOperator = 'equals'
	let rawValue = match[2]
	if (match[3] != null) {
		rawOperator = match[2].toLowerCase()
		rawValue = match[3]
	}
	if (rawOperator === 'in') {
		const values = parseList(rawValue)
		return typeof values === 'string' ? values : { header, operator: 'in', values }
	}
	if (rawOperator === 'regex') {
		const regex = parseRegex(rawValue)
		return typeof regex === 'string' ? regex : { header, operator: 'regex', ...regex }
	}
	const value = parseScalar(rawValue)
	return { header, operator: rawOperator === 'contains' || rawOperator === 'substring' ? 'substring' : 'equals', value }
}

/** Resolve a comma-separated `--select` list in stable user order. */
export const parseSelectHeaders = (input: string | undefined, schema: SheetSchema): SheetHeader[] | string => {
	if (!input) return schema.headers.filter((header) => !header.empty)
	const headers: SheetHeader[] = []
	for (const name of splitCommaList(input)) {
		const header = resolveHeader(schema, name)
		if (typeof header === 'string') return header
		if (headers.some((candidate) => candidate.index === header.index)) return `Header "${name}" was selected more than once.`
		headers.push(header)
	}
	return headers.length > 0 ? headers : '--select must include at least one header.'
}

/** Find the physical header inside a collapsed whole-sheet export without assigning coordinates to other export rows. */
export const findExportHeaderIndex = (rows: readonly (readonly string[])[], schema: SheetSchema): number => {
	const width = schema.headers.length
	return rows.findIndex((row) => {
		let matched = 0
		for (let column = 0; column < width; column++) {
			const exported = row[column] ?? ''
			if (!exported) continue
			if (exported !== schema.headers[column].original) return false
			matched++
		}
		return matched > 0
	})
}

/** Filter whole-export rows into coordinate-free candidates. */
export const queryExportRows = (rows: readonly (readonly string[])[], headerExportIndex: number, predicate: QueryPredicate): ExportRowCandidate[] => {
	const matches: ExportRowCandidate[] = []
	for (let index = headerExportIndex + 1; index < rows.length; index++) {
		const values = [...rows[index]]
		if (matchesPredicate(values[predicate.header.index - 1] ?? '', predicate)) matches.push({ exportRow: index + 1, values })
	}
	return matches
}

/** Project one query candidate to selected column names, preserving `--select` order. */
export const projectCandidate = (candidate: ExportRowCandidate | LocatedRowCandidate, headers: readonly SheetHeader[]): Record<string, string> => {
	const projected: Record<string, string> = {}
	for (const header of headers) projected[header.original] = candidate.values[header.index - 1] ?? ''
	return projected
}

/** Match one candidate row fingerprint against an exact physical row read. */
export const exactRowMatchesCandidate = (exactRow: readonly string[], candidate: ExportRowCandidate, width: number): boolean => {
	for (let column = 0; column < width; column++) {
		if ((exactRow[column] ?? '') !== (candidate.values[column] ?? '')) return false
	}
	return true
}

/** Attach authoritative coordinates after an exact physical read. */
export const locateCandidate = (candidate: ExportRowCandidate, sheetRow: number): LocatedRowCandidate => ({
	...candidate,
	sheetRow,
	a1: `A${sheetRow}:${indexToColumnLetters(Math.max(0, candidate.values.length - 1))}${sheetRow}`,
	exactVerified: true,
})

const matchesPredicate = (value: string, predicate: QueryPredicate): boolean => {
	switch (predicate.operator) {
		case 'equals':
			return value === predicate.value
		case 'in':
			return predicate.values.includes(value)
		case 'substring':
			return value.includes(predicate.value)
		case 'regex':
			return new RegExp(predicate.source, predicate.flags).test(value)
	}
}

const parseList = (value: string): string[] | string => {
	const trimmed = value.trim()
	if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return 'The in operator requires a bracket list, for example [872,873].'
	try {
		const parsed = JSON.parse(trimmed) as unknown
		if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((item) => !['string', 'number', 'boolean'].includes(typeof item))) {
			return 'The in list must contain one or more string, number, or boolean scalars.'
		}
		return parsed.map(String)
	} catch {
		const inner = trimmed.slice(1, -1)
		if (!inner.trim()) return 'The in list must not be empty.'
		return splitCommaList(inner).map(parseScalar)
	}
}

const parseRegex = (value: string): { source: string; flags: string } | string => {
	const trimmed = value.trim()
	const match = trimmed.match(/^\/(.*)\/([dgimsuvy]*)$/)
	const source = match?.[1] ?? parseScalar(trimmed)
	const flags = match?.[2] ?? ''
	try {
		new RegExp(source, flags)
		return { source, flags }
	} catch (error) {
		return `Invalid regex: ${error instanceof Error ? error.message : String(error)}`
	}
}

const parseScalar = (value: string): string => {
	const trimmed = value.trim()
	if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
		return trimmed.slice(1, -1)
	}
	return trimmed
}

const splitCommaList = (value: string): string[] => {
	const values: string[] = []
	let current = ''
	let quote: string | null = null
	for (const character of value) {
		if ((character === '"' || character === "'") && (quote == null || quote === character)) {
			quote = quote === character ? null : character
			current += character
		} else if (character === ',' && quote == null) {
			values.push(current.trim())
			current = ''
		} else current += character
	}
	if (current.trim() || value.endsWith(',')) values.push(current.trim())
	return values
}
