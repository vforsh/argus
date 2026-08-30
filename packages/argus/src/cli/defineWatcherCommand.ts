import type {
	ArgusDefineWatcherCommand,
	ArgusWatcherCommandContext,
	ArgusWatcherCommandRequestPlan,
	ArgusWatcherCommandRunner,
	ArgusWatcherCommandSpec,
} from '@vforsh/argus-plugin-api'
import type { ProtocolSchema } from '@vforsh/argus-core'
import { formatProtocolValidationIssues } from '@vforsh/argus-core'
import type { Output } from '../output/io.js'
import { createOutput } from '../output/io.js'
import {
	requestWatcherAction,
	requestWatcherJson,
	writeRequestError,
	type WatcherRequestInput,
	type WatcherRequestSuccess,
} from '../watchers/requestWatcher.js'

/**
 * Plan for a single watcher HTTP request, produced by a command's `build` step.
 *
 * Most commands return a constant plan; commands that adapt the path or timeout
 * to their inputs (`/storage/<area>`, `Math.max(30s, wait + 5s)`) compute the
 * plan from `options`. Returning `null` from `build` short-circuits the command
 * after the build step has written its own warning + set `process.exitCode`.
 *
 * Declared by `@vforsh/argus-plugin-api`; see the note in `requestWatcher.ts`.
 */
export type WatcherRequestPlan = ArgusWatcherCommandRequestPlan

/** Default request timeout when a plan does not specify one. */
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Shared one-shot request helper for commands that need the watcher metadata
 * for additional local work instead of a direct JSON/human render pipeline.
 */
export const requestWatcherCommandJson = async <T>(input: WatcherRequestInput, output: Output): Promise<WatcherRequestSuccess<T> | null> => {
	const result = await requestWatcherJson<T>(input)
	if (!result.ok) {
		writeRequestError(result, output)
		return null
	}
	return result
}

/**
 * Shared API-action request helper for command support modules that cannot use
 * `defineWatcherCommand` directly because they compose multiple watcher calls.
 */
export const requestWatcherCommandAction = requestWatcherAction

/** Context passed to `formatHuman` / `formatJson` after a successful request. */
export type WatcherCommandContext<TArgs extends readonly unknown[], TOptions> = ArgusWatcherCommandContext<TArgs, TOptions>

/**
 * Spec for a CLI command that talks to a watcher.
 *
 * The runner produced by {@link defineWatcherCommand} owns the cross-cutting
 * pipeline (createOutput → build → optional schema → requestWatcherAction →
 * JSON-vs-human dispatch). The spec only needs the parts that are unique to
 * this command.
 *
 * `TArgs` is a tuple of positional CLI arguments (excluding the watcher id and
 * the trailing options object). Most commands use `[]`; commands like `argus
 * fill <id> <value>` use `[string | undefined]`.
 *
 * Declared by `@vforsh/argus-plugin-api`; see the note in `requestWatcher.ts`.
 */
export type WatcherCommandSpec<
	TArgs extends readonly unknown[],
	TOptions extends { json?: boolean },
	TBody,
	TResponse extends { ok: true },
> = ArgusWatcherCommandSpec<TArgs, TOptions, TBody, TResponse>

/**
 * Runner produced by {@link defineWatcherCommand}. Signature is
 * `(id, ...args, options) => Promise<void>` — the same shape Commander
 * action callbacks already use, so the runner drops in unchanged.
 *
 * Declared by `@vforsh/argus-plugin-api`; see the note in `requestWatcher.ts`.
 */
export type WatcherCommandRunner<TArgs extends readonly unknown[], TOptions> = ArgusWatcherCommandRunner<TArgs, TOptions>

/**
 * Build a runner for a watcher CLI command.
 *
 * Pipeline (in order):
 *  1. `createOutput(options)` — JSON vs human stream selection.
 *  2. `spec.build(args, options, output)` — validation + body/path/timeout.
 *     Returning `null` cleanly aborts.
 *  3. Optional `spec.schema.parse(plan.body)` — protocol validation.
 *  4. `requestWatcherAction(...)` — resolve watcher + transport + ErrorResponse.
 *  5. JSON path: write `formatJson?.(...) ?? response`.
 *  6. Human path: call `formatHuman` (or pretty-print JSON as fallback).
 *
 * Type inference resolves `TArgs`/`TOptions`/`TResponse` from the spec, so most
 * call sites don't need explicit generics.
 */
export const defineWatcherCommand: ArgusDefineWatcherCommand =
	<TOptions extends { json?: boolean }, TResponse extends { ok: true }, TBody = unknown, TArgs extends readonly unknown[] = []>(
		spec: WatcherCommandSpec<TArgs, TOptions, TBody, TResponse>,
	): WatcherCommandRunner<TArgs, TOptions> =>
	async (id, ...rest) => {
		// `rest` ends with the options object; everything before it is positional CLI args.
		const tail = rest.length - 1
		const options = rest[tail] as TOptions
		const args = rest.slice(0, tail) as unknown as TArgs

		const output = createOutput({ ...options, json: options.json === true || spec.isJson?.(options) === true })

		const plan = await spec.build(args, options, output)
		if (plan == null) return

		const body = validateBody(plan, spec.schema, output)
		if (body === SCHEMA_REJECTED) return

		const result = await requestWatcherAction<TResponse>(
			{
				id,
				path: plan.path,
				method: plan.method ?? (plan.body !== undefined ? 'POST' : 'GET'),
				body,
				query: plan.query,
				timeoutMs: plan.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			},
			output,
		)
		if (!result) return

		const ctx: WatcherCommandContext<TArgs, TOptions> = { output, watcher: result.watcher, args, options }

		if (output.json) {
			output.writeJson(spec.formatJson ? spec.formatJson(result.data, ctx) : result.data)
			return
		}
		if (spec.formatHuman) {
			spec.formatHuman(result.data, ctx)
			return
		}
		output.writeHuman(JSON.stringify(result.data, null, 2))
	}

/** Sentinel returned by {@link validateBody} when schema validation failed. */
const SCHEMA_REJECTED = Symbol('schema-rejected')

/**
 * Validate `plan.body` against an optional schema. On failure, write a warning,
 * set `process.exitCode = 2`, and return {@link SCHEMA_REJECTED} so the caller
 * can early-exit. On success (or when no schema is provided), return the body
 * to send.
 */
const validateBody = <TBody>(
	plan: WatcherRequestPlan,
	schema: ProtocolSchema<TBody> | undefined,
	output: Output,
): unknown | typeof SCHEMA_REJECTED => {
	if (!schema || plan.body === undefined) return plan.body

	const parsed = schema.parse(plan.body)
	if (parsed.ok) return parsed.value

	output.writeWarn(formatProtocolValidationIssues(parsed.issues))
	process.exitCode = 2
	return SCHEMA_REJECTED
}
