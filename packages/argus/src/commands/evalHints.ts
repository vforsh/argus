import { closeSync, mkdirSync, openSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import type { Output } from '../output/io.js'
import { getArgusHomeDir } from '../config/argusHome.js'

/**
 * One-line stderr hints that name the command an eval pattern should have been.
 *
 * Observed agent evals hand-rolled what Argus already does: 983 wrapped several values in
 * `JSON.stringify({…})` (→ `probe`), 199 polled with `setTimeout`/`new Promise` (→ `wait` /
 * `--until`). Hints go to stderr only, so stdout stays the payload, and always before the result: agents
 * read output through `2>&1 | tail -1`, where a trailing hint replaced the value they asked for.
 *
 * Each key fires at most once per {@link HINT_INTERVAL_MS} across processes. A per-process limit let the
 * same hint repeat on every call: a week of transcripts showed the eval hints ~130 times (and a since-removed
 * `argus run` hint 128 times) with no change in what agents typed, so repeats are noise, not teaching.
 */

const HINT_INTERVAL_MS = 30 * 60_000

const shown = new Set<string>()

/** Write `text` under `key`, at most once per process and once per {@link HINT_INTERVAL_MS} machine-wide. */
export const writeHintOnce = (key: string, text: string, output: Output): void => {
	if (shown.has(key) || process.env.ARGUS_NO_HINTS === '1') return
	shown.add(key)
	if (!claimHintSlot(key)) return
	output.writeWarn(`hint: ${text}`)
}

/**
 * Claim the right to show `key` now. One marker file per key; its mtime is when the hint last showed.
 *
 * Race-free without a lock: a missing marker is created with `wx` (exactly one process succeeds), and a
 * stale one is first renamed away (exactly one rename succeeds; the losers see ENOENT). A shared JSON
 * file lost concurrent claims and could be read half-written. Any other failure (read-only home) shows
 * the hint, as before the throttle existed.
 */
const claimHintSlot = (key: string): boolean => {
	const marker = path.join(getArgusHomeDir(), 'hints', key)
	try {
		mkdirSync(path.dirname(marker), { recursive: true })
		const shownAt = markerTime(marker)
		if (shownAt !== undefined) {
			if (Date.now() - shownAt < HINT_INTERVAL_MS) return false
			const stale = `${marker}.${process.pid}.stale`
			renameSync(marker, stale)
			rmSync(stale, { force: true })
		}
		closeSync(openSync(marker, 'wx'))
		return true
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		return code !== 'ENOENT' && code !== 'EEXIST'
	}
}

const markerTime = (marker: string): number | undefined => {
	try {
		return statSync(marker).mtimeMs
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
		throw error
	}
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
