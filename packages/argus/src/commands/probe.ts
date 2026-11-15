import { evalWithRetries } from '../eval/evalClient.js'
import { createOutput, type Output } from '../output/io.js'
import { setExitCode } from '../output/exitCode.js'
import { resolveWatcherOrExit } from '../watchers/requestWatcher.js'
import { formatError } from '../cli/parse.js'
import { createEvalEmitter } from './evalEmit.js'
import { parseEvalCommonFlags, type EvalCommonOptions } from './evalShared.js'
import { readTextInput, type TextInputNames } from './inputSource.js'
import { parsePreReadWaitFlags, runPreReadWait, type PreReadWaitFlags } from './preReadWait.js'

/**
 * `argus probe <id> name=expr …`: several named reads in one round-trip, each isolated.
 *
 * 983 of 1 622 observed eval lines wrapped their answer in `JSON.stringify({a: …, b: …})`, and a
 * third of those added `try/catch` or `?.` so one missing global would not void the whole call.
 * Here every expression runs in its own try/catch inside one injected function: a throw becomes
 * `{"__error": "<message>"}` for that key only.
 *
 * Composed on the existing `/eval` route on purpose: the watcher sees an ordinary expression, so
 * probe works against any watcher version and inherits iframe selection, retries, and timeouts.
 */

export type ProbeOptions = Pick<EvalCommonOptions, 'json' | 'await' | 'timeout' | 'retry' | 'silent' | 'fields' | 'maxChars'> &
	PreReadWaitFlags & {
		quiet?: boolean
		/** Exit 1 when any key threw (default: a failing key is part of the answer). */
		failOnException?: boolean
		file?: string
		stdin?: boolean
	}

/** One `name=expression` pair; bare expressions get a positional `_<n>` key. */
type ProbeEntry = { key: string; expression: string }

/** Marker key for an expression that threw (or could not be serialized). */
const PROBE_ERROR_KEY = '__error'

export const runProbe = async (id: string | undefined, rawPairs: string[], options: ProbeOptions): Promise<void> => {
	if (options.quiet) options.silent = true
	const output = createOutput(options)

	// `argus probe url=location.href` with no id: the "id" is the first pair. Watcher ids never hold `=`/`(`/space;
	// `@page` selectors may, so they always stay the id.
	const pairs = [...rawPairs]
	let watcherId = id
	if (watcherId != null && !watcherId.startsWith('@') && /[=(\s]/.test(watcherId)) {
		pairs.unshift(watcherId)
		watcherId = undefined
	}

	const entries = await collectProbeEntries(pairs, options, output)
	if (!entries) {
		setExitCode(2)
		return
	}

	const flags = parseEvalCommonFlags(options, output)
	if (!flags) return
	const wait = parsePreReadWaitFlags(options, output)
	if (!wait) return

	const resolved = await resolveWatcherOrExit({ id: watcherId }, output)
	if (!resolved) return
	if (!(await runPreReadWait(resolved.watcher, wait, output))) return

	const awaitValues = options.await ?? true
	const { script, localErrors } = buildProbeScript(entries, awaitValues)
	const emitter = createEvalEmitter(options, output, flags.shaping)
	const result = await evalWithRetries({
		watcher: resolved.watcher,
		expression: script,
		awaitPromise: awaitValues,
		returnByValue: true,
		timeoutMs: flags.timeoutMs,
		failOnException: true,
		retryCount: flags.retryCount,
	})
	if (!result.ok) {
		await emitter.emitError(result)
		setExitCode(1)
		return
	}

	const pageValues = result.response.result as Record<string, unknown>
	// Keep the caller's key order; local syntax errors never reached the page.
	const ordered = Object.fromEntries(
		entries.map((entry) => [entry.key, Object.hasOwn(localErrors, entry.key) ? localErrors[entry.key] : (pageValues[entry.key] ?? null)]),
	)
	const failed = entries.filter((entry) => isProbeError(ordered[entry.key])).map((entry) => entry.key)
	if (failed.length > 0 && options.failOnException) {
		const message = `probe: ${failed.join(', ')} threw`
		setExitCode(1)
		// `--json` failures are one `ok: false` document; the partial answer rides along.
		if (output.json) {
			output.writeJson({ ok: false, error: { message, code: 'eval_exception' }, result: ordered })
			return
		}
		await emitter.emitSuccess({ ...result.response, result: ordered, type: 'object' }, false)
		output.writeWarn(message)
		return
	}
	await emitter.emitSuccess({ ...result.response, result: ordered, type: 'object' }, false)
}

const isProbeError = (value: unknown): boolean => value != null && typeof value === 'object' && PROBE_ERROR_KEY in value

const PROBE_INPUT_NAMES: TextInputNames = {
	inline: 'name=expression arguments',
	file: '--file',
	stdin: '--stdin',
	missing: 'Nothing to probe. Pass name=expression pairs (e.g. url=location.href), --file, or --stdin.',
}

/**
 * Arguments first, then `--file` or `--stdin`. Keys must be unique: a repeated key would silently
 * drop a value, so it is a usage error instead.
 */
const collectProbeEntries = async (pairs: string[], options: ProbeOptions, output: Output): Promise<ProbeEntry[] | null> => {
	if (options.file != null && options.stdin) {
		output.writeWarn('Provide only one of: --file, --stdin')
		return null
	}

	const sources: string[][] = [pairs]
	if (options.file != null || options.stdin) {
		const selection = options.file != null ? ({ kind: 'file', path: options.file } as const) : ({ kind: 'stdin' } as const)
		const text = await readTextInput(selection, PROBE_INPUT_NAMES, output, 'Probe map')
		if (text == null) return null
		const parsed = parseProbeMap(text)
		if ('error' in parsed) {
			output.writeWarn(parsed.error)
			return null
		}
		sources.push(parsed.value)
	}

	const entries: ProbeEntry[] = []
	for (const raw of sources.flat()) {
		const entry = parseProbePair(raw, entries.length)
		if (RESERVED_KEYS.has(entry.key)) {
			output.writeWarn(`Probe key ${JSON.stringify(entry.key)} is reserved; pick another name.`)
			return null
		}
		if (!entry.expression) {
			output.writeWarn(`Empty expression for ${JSON.stringify(entry.key)}.`)
			return null
		}
		if (entries.some((existing) => existing.key === entry.key)) {
			output.writeWarn(`Duplicate probe key ${JSON.stringify(entry.key)}.`)
			return null
		}
		entries.push(entry)
	}
	if (entries.length === 0) {
		output.writeWarn(PROBE_INPUT_NAMES.missing)
		return null
	}
	return entries
}

/**
 * `name=expr` → named; anything else is a bare expression keyed by its position (`_0`, `_1`).
 * `a===b` and `a==b` stay bare: the `=` after the name must not start a comparison.
 */
const PAIR_PATTERN = /^([A-Za-z_$][\w$-]*)=(?!=)([\s\S]*)$/

/** `__proto__` would set a prototype instead of a key, on the page and here. */
const RESERVED_KEYS = new Set(['__proto__'])

const parseProbePair = (raw: string, index: number): ProbeEntry => {
	const match = PAIR_PATTERN.exec(raw.trim())
	if (match) return { key: match[1]!, expression: trimExpression(match[2]!) }
	return { key: `_${index}`, expression: trimExpression(raw) }
}

/** A trailing `;` is a statement terminator agents type out of habit; inside `( … )` it is a syntax error. */
const trimExpression = (expression: string): string => expression.trim().replace(/;+$/, '').trim()

/**
 * A `--file`/`--stdin` map: a JSON object `{ "name": "expr" }`, or one `name=expr` (or bare
 * expression) per line with `#` comments. Returned as raw pairs so arguments and files share one parser.
 */
const parseProbeMap = (text: string): { value: string[] } | { error: string } => {
	const trimmed = text.trim()
	if (trimmed.startsWith('{')) {
		let parsed: unknown
		try {
			parsed = JSON.parse(trimmed)
		} catch (error) {
			return { error: `Invalid probe JSON: ${formatError(error)}` }
		}
		if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'Probe JSON must be an object of name → expression.' }
		const pairs: string[] = []
		for (const [key, value] of Object.entries(parsed)) {
			if (typeof value !== 'string') return { error: `Probe JSON value for ${JSON.stringify(key)} must be an expression string.` }
			if (!/^[A-Za-z_$][\w$-]*$/.test(key)) return { error: `Invalid probe key ${JSON.stringify(key)}: use letters, digits, _, $, or -.` }
			pairs.push(`${key}=${value}`)
		}
		return { value: pairs }
	}
	return {
		value: text
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line !== '' && !line.startsWith('#')),
	}
}

/**
 * One injected call that evaluates every entry in order, each inside its own try/catch.
 *
 * The user expressions are thunks in the *argument list*, so they close over the page's globals
 * only: the runner's own bindings (`out`, `read`, …) live in the callee's body, where a page global
 * named `read` would otherwise have been shadowed.
 *
 * Expressions that do not parse are caught here, in Node, before anything is sent: one syntax error
 * would otherwise void the whole call, which is the failure this command exists to stop. Each value
 * is snapshotted through JSON inside its own try/catch — what `toJSON` returns is what comes back,
 * cycles (`window`) and BigInt fail only their key, and a later expression cannot make an earlier
 * value cyclic. `undefined` and functions come back as `null` so the key is still there to read.
 */
const buildProbeScript = (entries: ProbeEntry[], awaitValues: boolean): { script: string; localErrors: Record<string, unknown> } => {
	const localErrors: Record<string, unknown> = {}
	const thunks: string[] = []
	const asyncPrefix = awaitValues ? 'async ' : ''
	for (const entry of entries) {
		const syntaxError = checkExpressionSyntax(entry.expression, awaitValues)
		if (syntaxError) {
			localErrors[entry.key] = { [PROBE_ERROR_KEY]: syntaxError }
			continue
		}
		thunks.push(`\t[${JSON.stringify(entry.key)}, ${asyncPrefix}() => (\n${entry.expression}\n)],`)
	}

	const pending = awaitValues ? 'await ' : ''
	const script = `(${asyncPrefix}(entries) => {
	const out = {}
	${PAGE_DESCRIBE_ERROR}
	for (const [key, get] of entries) {
		try {
			const json = JSON.stringify(${pending}get())
			out[key] = json === undefined ? null : JSON.parse(json)
		} catch (error) {
			out[key] = { ${PROBE_ERROR_KEY}: describe(error) }
		}
	}
	return out
})([
${thunks.join('\n')}
])`
	return { script, localErrors }
}

/** Page-side `describe(error)` → `"TypeError: message"`, shared by the injected probe and `dom info --pick` scripts. */
export const PAGE_DESCRIBE_ERROR =
	"const describe = (error) => (error && typeof error === 'object' && 'message' in error ? `${error.name || 'Error'}: ${error.message}` : String(error))"

const checkExpressionSyntax = (expression: string, awaitValues: boolean): string | undefined => {
	try {
		new Function(`return ${awaitValues ? 'async ' : ''}() => (\n${expression}\n)`)
		return undefined
	} catch (error) {
		return error instanceof SyntaxError ? `SyntaxError: ${error.message}` : formatError(error)
	}
}
