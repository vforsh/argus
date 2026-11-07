import { AsyncLocalStorage } from 'node:async_hooks'
import { fstatSync } from 'node:fs'
import { projectFields, type FieldTree } from './projection.js'

/**
 * Per-invocation output shaping applied below every command's own formatting.
 *
 * Agents piped ~56% of Argus calls through `head`/`tail`/`grep` and kept passing `-q`,
 * `--fields`, and `--max-chars` to commands that never declared them. Instead of teaching ~200
 * commands each flag, `defineCommand` gives every command the missing ones and the runner installs
 * one of these scopes; {@link createOutput} consults it on every stdout write.
 *
 * Async-local because `argus session` may run a dialog control beside an in-flight request.
 */
export type OutputScope = {
	/** Hold stdout until the command settles; drop it on success. */
	quiet: boolean
	/** `--fields` for commands that do not shape their own output: projects every success JSON document. */
	fields?: FieldTree
	/** Cap on human stdout characters (explicit `--max-chars`, or the piped default). */
	humanMaxChars?: number
	/** Whether {@link humanMaxChars} is the implicit piped default rather than a typed flag. */
	defaultCap: boolean
	/** Explicit `--max-chars` for commands that do not shape their own JSON. */
	jsonMaxChars?: number
	used: number
	omitted: number
	held: string[]
}

const scopes = new AsyncLocalStorage<OutputScope>()

/** Run a command body with `scope` applied to every {@link createOutput} it creates. */
export const runWithOutputScope = <T>(scope: OutputScope, body: () => Promise<T>): Promise<T> => scopes.run(scope, body)

/** Run a command body outside any enclosing scope (a step of `argus run` inside the outer `run`). */
export const runWithoutOutputScope = <T>(body: () => Promise<T>): Promise<T> => scopes.exit(body)

/**
 * Default human-output cap when stdout is not a terminal (an agent or a pipe).
 *
 * Large enough that ordinary answers never hit it, small enough that a page dump or a log burst
 * cannot flood an agent's context. `ARGUS_MAX_CHARS` overrides it; `0` disables the default.
 */
export const DEFAULT_PIPED_MAX_CHARS = 20_000

export const resolveDefaultMaxChars = (): number | undefined => {
	// A terminal is a human; a file is a redirect (`> body.json`) whose bytes must stay whole.
	// Only a pipe — how agent shells read commands — gets the default.
	if (process.stdout.isTTY || stdoutIsFile()) return undefined
	const raw = process.env.ARGUS_MAX_CHARS?.trim()
	if (raw == null || raw === '') return DEFAULT_PIPED_MAX_CHARS
	const parsed = Number(raw)
	if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_PIPED_MAX_CHARS
	return parsed === 0 ? undefined : parsed
}

const stdoutIsFile = (): boolean => {
	try {
		return fstatSync(1).isFile()
	} catch {
		return false
	}
}

/**
 * Route one stdout chunk through the scope: budget human text, hold everything when quiet.
 * `data` (JSON documents, exported files) is never cut, since a partial one is unusable.
 */
export const writeScopedStdout = (chunk: string, kind: 'human' | 'data'): void => {
	const scope = scopes.getStore()
	if (!scope) {
		process.stdout.write(chunk)
		return
	}

	let text = chunk
	if (kind === 'human' && scope.humanMaxChars !== undefined) {
		const room = Math.max(0, scope.humanMaxChars - scope.used)
		if (text.length > room) {
			scope.omitted += text.length - room
			text = text.slice(0, room)
		}
		scope.used += text.length
		if (text === '') return
	}

	if (scope.quiet) {
		scope.held.push(text)
		return
	}
	process.stdout.write(text)
}

/** `--fields` / `--max-chars` for a JSON document of a command that does not shape its own. */
export const shapeScopedJson = (value: unknown): unknown => {
	const scope = scopes.getStore()
	if (!scope || isFailureDocument(value)) return value

	const projected = scope.fields ? projectFields(value, scope.fields) : value
	if (scope.jsonMaxChars === undefined) return projected

	const serialized = JSON.stringify(projected) ?? ''
	if (serialized.length <= scope.jsonMaxChars) return projected
	return { truncated: true, totalChars: serialized.length, result: serialized.slice(0, scope.jsonMaxChars) }
}

const isFailureDocument = (value: unknown): boolean => value != null && typeof value === 'object' && (value as { ok?: unknown }).ok === false

/**
 * Settle a scope once its command finished: release held output if the command failed, and name
 * what the cap cut so the reader knows the answer is partial and how to get the rest.
 */
export const finishOutputScope = (scope: OutputScope, failed: boolean): void => {
	if (scope.quiet && failed) {
		for (const chunk of scope.held) process.stdout.write(chunk)
	}
	scope.held = []

	if (scope.omitted === 0 || (scope.quiet && !failed)) return
	const hint = scope.defaultCap ? 'pass --max-chars <n> for more, or ARGUS_MAX_CHARS=0 to disable the piped default' : 'raise --max-chars'
	const prefix = scope.used > 0 ? '\n' : ''
	process.stdout.write(`${prefix}… [truncated ${scope.omitted} chars; ${hint}]\n`)
}
