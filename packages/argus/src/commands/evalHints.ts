import type { Output } from '../output/io.js'

/**
 * One-line stderr hints that name the command an eval pattern should have been.
 *
 * Observed agent evals hand-rolled what Argus already does: 983 wrapped several values in
 * `JSON.stringify({…})` (→ `probe`), 199 polled with `setTimeout`/`new Promise` (→ `wait` /
 * `--until`). Hints go to stderr only, so stdout stays the payload, and each fires once per process.
 */

const shown = new Set<string>()

/** Write `text` once per process under `key`. */
export const writeHintOnce = (key: string, text: string, output: Output): void => {
	if (shown.has(key) || process.env.ARGUS_NO_HINTS === '1') return
	shown.add(key)
	output.writeWarn(`hint: ${text}`)
}

/** Hints derived from the expression text alone, before it runs. */
export const writeExpressionHints = (expression: string, output: Output): void => {
	if (/\bsetTimeout\s*\(|\bnew\s+Promise\s*\(/.test(expression)) {
		writeHintOnce(
			'poll',
			'to wait for page state use `argus wait <id> "<condition>"` or `argus eval <id> "<expr>" --until "<condition>"` instead of a setTimeout/Promise loop',
			output,
		)
	}
	if (stringifiesMultiKeyObject(expression)) {
		writeHintOnce(
			'stringify',
			'`argus probe <id> a=<expr> b=<expr>` reads several values in one call, each isolated (no JSON.stringify, try/catch, or ?. needed)',
			output,
		)
	}
}

/**
 * `JSON.stringify({ a: …, b: … })` with more than one top-level key. A rough scan (strings and
 * nesting are tracked, template literals and regexes are not): a hint that misfires costs one stderr line.
 */
const stringifiesMultiKeyObject = (expression: string): boolean => {
	const pattern = /JSON\.stringify\(\s*\{/g
	for (let match = pattern.exec(expression); match; match = pattern.exec(expression)) {
		let depth = 0
		let commas = 0
		let quote: string | null = null
		for (let index = match.index + match[0].length - 1; index < expression.length; index += 1) {
			const char = expression[index]!
			if (quote) {
				if (char === '\\') index += 1
				else if (char === quote) quote = null
				continue
			}
			if (char === '"' || char === "'" || char === '`') quote = char
			else if (char === '{' || char === '(' || char === '[') depth += 1
			else if (char === '}' || char === ')' || char === ']') {
				depth -= 1
				if (depth === 0) break
			} else if (char === ',' && depth === 1) commas += 1
		}
		if (commas >= 1) return true
	}
	return false
}
