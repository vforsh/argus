import type { EvalResponse } from '@vforsh/argus-core'
import { previewStringify } from '@vforsh/argus-core'
import { readFile } from 'node:fs/promises'
import { formatError, parseNumber } from '../cli/parse.js'
import type { Output } from '../output/io.js'
import { parseDurationMs } from '@vforsh/argus-core'
import { type EvalArgMap, type EvalArgSourceOptions, hasEvalArgs, resolveEvalArgs } from './evalArgs.js'
import { bundleEvalEntry } from './evalBundle.js'
import { fileUsesModuleSyntax } from './evalModuleSyntax.js'
import { createEvalResultFileSink, type EvalResultFileOptions } from './evalResultOutput.js'
import { readTextInput, selectTextInput, type TextInputSelection } from './inputSource.js'

// Re-export eval arg helpers for existing imports and tests.
export { type EvalArgMap, hasEvalArgs, parseEvalArgFlags as parseEvalArgs } from './evalArgs.js'

// Re-export shared parsers so existing eval imports keep working.
export { formatError, parseNumber } from '../cli/parse.js'

// ---------------------------------------------------------------------------
// Expression resolution
// ---------------------------------------------------------------------------

type ExpressionSourceOptions = {
	file?: string
	stdin?: boolean
	inject?: string
	/** Force bundling for `--file`. */
	bundle?: boolean
	/** Skip bundling; disables auto-bundle when the file uses import/export. */
	noBundle?: boolean
}

type EvalExpressionOptions = ExpressionSourceOptions &
	EvalArgSourceOptions & {
		iframe?: string
		iframeNamespace?: string
		iframeTimeout?: string
	}

export type PreparedEvalExpression = {
	expression: string
	args?: EvalArgMap
	/** Bundled file expressions receive the temporary watcher scenario bridge. */
	scenario?: boolean
}

/** Resolve script input, eval args, and iframe wrapping into the payload sent to the watcher. */
export const prepareEvalExpression = async (
	inline: string | undefined,
	options: EvalExpressionOptions,
	output: Output,
): Promise<PreparedEvalExpression | null> => {
	const args = await resolveEvalArgs(options, output)
	if (args == null) {
		return null
	}

	const resolved = await resolveExpressionSource(inline, options, output)
	if (resolved == null) {
		return null
	}

	if (!options.iframe) {
		return {
			expression: resolved.expression,
			args: hasEvalArgs(args) ? args : undefined,
			scenario: resolved.scenario,
		}
	}

	const iframeTimeoutMs = parseDurationFlagMs(options.iframeTimeout, '--iframe-timeout')
	if (iframeTimeoutMs.error) {
		output.writeWarn(iframeTimeoutMs.error)
		return null
	}

	return {
		expression: wrapForIframeEval(wrapExpressionWithArgs(resolved.expression, args), {
			selector: options.iframe,
			namespace: options.iframeNamespace ?? 'argus',
			timeoutMs: iframeTimeoutMs.value ?? 5000,
		}),
		scenario: resolved.scenario,
	}
}

/**
 * Resolve the JS expression from inline argument, --file, or --stdin.
 * Returns `null` (and writes a warning) when the input is invalid.
 */
export const resolveExpression = async (inline: string | undefined, options: ExpressionSourceOptions, output: Output): Promise<string | null> => {
	const resolved = await resolveExpressionSource(inline, options, output)
	return resolved?.expression ?? null
}

type ResolvedExpressionSource = { expression: string; scenario?: true }

const resolveExpressionSource = async (
	inline: string | undefined,
	options: ExpressionSourceOptions,
	output: Output,
): Promise<ResolvedExpressionSource | null> => {
	// Checked before the source is picked: "--bundle needs --file" is the more actionable message
	// when a user passes --bundle with no expression at all.
	if ((options.bundle || options.noBundle) && options.file == null) {
		output.writeWarn('--bundle and --no-bundle require --file')
		return null
	}

	const selection = selectTextInput({ inline, file: options.file, stdin: options.stdin }, EXPRESSION_INPUT_NAMES, output)
	if (!selection) {
		return null
	}

	const source = selection.kind === 'file' ? await resolveFileExpression(selection.path, options, output) : await readInlineExpression(selection, output)
	if (!source) {
		return null
	}

	const injected = await prependInjectSource(source.expression, options.inject, output)
	return injected == null ? null : { expression: injected, scenario: source.scenario }
}

const EXPRESSION_INPUT_NAMES = {
	inline: 'an inline expression',
	file: '--file',
	stdin: '--stdin',
	missing: 'Expression is required. Provide an inline expression, --file, or --stdin (or pass - as expression).',
} as const

const readInlineExpression = async (
	selection: TextInputSelection,
	output: Output,
): Promise<ResolvedExpressionSource | null> => {
	const expression = await readTextInput(selection, EXPRESSION_INPUT_NAMES, output, 'Expression')
	return expression == null ? null : { expression }
}

/** A `--file` expression may be bundled first; `--bundle`/`--no-bundle` and module syntax decide. */
const resolveFileExpression = async (
	filePath: string,
	options: ExpressionSourceOptions,
	output: Output,
): Promise<ResolvedExpressionSource | null> => {
	const fileContent = await readTextInput({ kind: 'file', path: filePath }, EXPRESSION_INPUT_NAMES, output, 'File')
	if (fileContent == null) {
		return null
	}

	const bundleDecision = resolveBundleDecision(options, fileContent)
	if (bundleDecision.autoEnabled) {
		output.writeWarn('Detected import/export in --file; bundling automatically. Pass --no-bundle to read the file as-is.')
	}

	if (!bundleDecision.shouldBundle) {
		return { expression: fileContent }
	}

	const bundled = await bundleEvalEntry(filePath)
	if (!bundled.ok) {
		output.writeWarn(`Failed to bundle --file: ${bundled.error}`)
		return null
	}

	if (!bundled.code.trim()) {
		output.writeWarn(`Bundled file is empty: ${filePath}`)
		return null
	}

	return { expression: bundled.code, scenario: true }
}

type BundleDecision = { shouldBundle: boolean; autoEnabled: boolean }

/**
 * `--no-bundle` wins over `--bundle` and auto-detection.
 * Auto-bundle applies when leading script text uses import/export.
 */
export const resolveBundleDecision = (options: ExpressionSourceOptions, fileContent: string): BundleDecision => {
	if (options.noBundle) {
		return { shouldBundle: false, autoEnabled: false }
	}

	if (options.bundle) {
		return { shouldBundle: true, autoEnabled: false }
	}

	if (!fileUsesModuleSyntax(fileContent)) {
		return { shouldBundle: false, autoEnabled: false }
	}

	return { shouldBundle: true, autoEnabled: true }
}

const prependInjectSource = async (expression: string, injectPath: string | undefined, output: Output): Promise<string | null> => {
	if (injectPath == null) {
		return expression
	}

	try {
		const injectSource = await readFile(injectPath, 'utf8')
		if (!injectSource.trim()) {
			output.writeWarn(`Inject file is empty: ${injectPath}`)
			return null
		}

		return `${injectSource}\n${expression}`
	} catch (error) {
		output.writeWarn(`Failed to read --inject: ${formatError(error)}`)
		return null
	}
}


// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/** Parse `--retry` flag into a non-negative integer. */
export const parseRetryCount = (value?: string): { value: number; error?: string } => {
	if (value == null) {
		return { value: 0 }
	}

	const parsed = Number(value)
	if (!Number.isInteger(parsed) || parsed < 0) {
		return { value: 0, error: 'Invalid --retry value: expected a non-negative integer.' }
	}

	return { value: parsed }
}

/** Parse `--interval` flag into milliseconds. Accepts bare numbers or durations (250ms, 3s, 2m). */
export const parseIntervalMs = (value?: string): { value?: number; error?: string } => {
	return parseDurationFlagMs(value, '--interval')
}

/** Parse eval timeout flags. Bare numbers remain milliseconds for compatibility; unit suffixes opt into durations. */
export const parseTimeoutMs = (value?: string): { value?: number; error?: string } => {
	return parseDurationFlagMs(value, '--timeout')
}

/** Parse timeout-like flags. Bare numbers mean milliseconds; unit suffixes support ms/s/m/h/d. */
export const parseDurationFlagMs = (value: string | undefined, flagName: string): { value?: number; error?: string } => {
	if (value == null) {
		return {}
	}

	const trimmed = value.trim()
	if (!trimmed) {
		return { error: `Invalid ${flagName} value: empty duration.` }
	}

	const parsed = /^[0-9]+(?:\.[0-9]+)?$/.test(trimmed) ? Number(trimmed) : parseDurationMs(trimmed)
	if (parsed == null || !Number.isFinite(parsed) || parsed <= 0) {
		return { error: `Invalid ${flagName} value: expected milliseconds or a duration like 250ms, 30s, 2m.` }
	}

	return { value: parsed }
}

/** Parse `--count` flag into a positive integer. */
export const parseCount = (value?: string): { value?: number; error?: string } => {
	if (value == null) {
		return {}
	}

	const parsed = Number(value)
	if (!Number.isInteger(parsed) || parsed <= 0) {
		return { error: 'Invalid --count value: expected a positive integer.' }
	}

	return { value: parsed }
}

/** Prepend the reserved `args` binding only when eval arguments were supplied. */
export const wrapExpressionWithArgs = (source: string, args: EvalArgMap): string => {
	if (!hasEvalArgs(args)) {
		return source
	}

	return `const args = Object.freeze(${JSON.stringify(args)});\n${source}`
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Format an exception response into a human-readable string. */
export const formatException = (response: EvalResponse): string => {
	if (!response.exception) {
		return ''
	}
	if (response.exception.details) {
		return `Exception: ${response.exception.text}\n${previewStringify(response.exception.details)}`
	}
	return `Exception: ${response.exception.text}`
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

/** Failure shape used by eval emitters. */
export type EvalAttemptFailure = {
	ok: false
	kind: 'transport' | 'exception'
	error: string
	response?: EvalResponse
	attempt: number
}

export type EvalEmitOptions = EvalResultFileOptions & {
	json?: boolean
	silent?: boolean
}

/** Writes eval results to stdout/stderr and optionally to `--out`. */
export type EvalEmitter = {
	emitSuccess: (response: EvalResponse, streaming: boolean) => Promise<void>
	emitError: (error: EvalAttemptFailure | { kind: 'until'; error: string }) => void
}

/** Create stdout/stderr and optional file sinks for eval command output. */
export const createEvalEmitter = (options: EvalEmitOptions, output: Output): EvalEmitter => {
	const fileSink = createEvalResultFileSink(options)

	return {
		emitSuccess: async (response, streaming) => {
			await fileSink?.write(response, streaming)
			writeEvalSuccess(response, options, output, streaming)

			if (fileSink && !streaming && !options.silent) {
				output.writeHuman(`Result saved: ${fileSink.displayPath}`)
			}
		},
		emitError: (error) => {
			writeEvalError(error, options, output)
		},
	}
}

const writeEvalSuccess = (response: EvalResponse, options: EvalEmitOptions, output: Output, streaming: boolean): void => {
	if (options.silent) {
		return
	}

	if (options.json) {
		if (streaming) {
			output.writeJsonLine(response)
		} else {
			output.writeJson(response)
		}
		return
	}

	if (response.exception) {
		output.writeHuman(formatException(response))
		return
	}

	output.writeHuman(previewStringify(response.result))
}

const writeEvalError = (error: EvalAttemptFailure | { kind: 'until'; error: string }, options: EvalEmitOptions, output: Output): void => {
	if (options.json && 'response' in error && error.response) {
		output.writeJsonLine(error.response)
	}

	if (error.kind === 'exception' && 'response' in error && error.response?.exception) {
		output.writeWarn(formatException(error.response))
		return
	}

	output.writeWarn(error.error)
}

/** Write a successful eval response to stdout/stderr only. */
export const printSuccess = writeEvalSuccess

/** Write an eval error to stdout/stderr only. */
export const printError = writeEvalError

// ---------------------------------------------------------------------------
// Iframe wrapping
// ---------------------------------------------------------------------------

/** Configuration for wrapping an expression for iframe eval via postMessage. */
export type IframeWrapConfig = {
	selector: string
	namespace: string
	timeoutMs: number
}

/**
 * Wrap an expression to eval it in an iframe via postMessage.
 * The iframe must have the argus helper script loaded.
 */
export const wrapForIframeEval = (code: string, config: IframeWrapConfig): string => {
	const { selector, namespace, timeoutMs } = config
	const evalType = `${namespace}:eval`
	const resultType = `${namespace}:eval-result`

	// Escape the code for embedding in a string
	const escapedCode = JSON.stringify(code)

	return `(async () => {
  const iframe = document.querySelector(${JSON.stringify(selector)});
  if (!iframe) throw new Error('Iframe not found: ${selector.replace(/'/g, "\\'")}');
  if (!iframe.contentWindow) throw new Error('Iframe has no contentWindow');
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error('Iframe eval timeout after ${timeoutMs}ms'));
    }, ${timeoutMs});
    const handler = (e) => {
      if (e.data?.type !== '${resultType}' || e.data.id !== id) return;
      clearTimeout(timeout);
      window.removeEventListener('message', handler);
      if (e.data.ok) resolve(e.data.result);
      else reject(new Error(e.data.error));
    };
    window.addEventListener('message', handler);
    iframe.contentWindow.postMessage({ type: '${evalType}', id, code: ${escapedCode} }, '*');
  });
})()`
}

/**
 * Flags `eval` and `eval-until` both accept.
 *
 * The two commands share their entire expression/args/iframe/out surface; only `--until`
 * versus `--total-timeout` semantics differ. Declaring the shared half once means a new
 * shared flag is added in one place instead of four.
 */
export type EvalCommonOptions = {
	json?: boolean
	await?: boolean
	timeout?: string
	returnByValue?: boolean
	failOnException?: boolean
	retry?: string
	silent?: boolean
	interval?: string
	count?: string
	/** Read expression from a file path. */
	file?: string
	/** Bundle local imports from `--file` before eval. */
	bundle?: boolean
	/** Do not bundle `--file` (disables auto-bundle for import/export). */
	noBundle?: boolean
	/** Read expression from stdin. Also activated when expression is `-`. */
	stdin?: boolean
	/** Read setup code from a file and run it before the expression. */
	inject?: string
	/** CSS selector for iframe to eval in via postMessage (extension mode). */
	iframe?: string
	/** Message type prefix for iframe eval (default: argus). */
	iframeNamespace?: string
	/** Timeout for iframe postMessage response (default: 5000; accepts duration syntax). */
	iframeTimeout?: string
	/** Repeated key=value arguments exposed to scripts as `args`. */
	arg?: string[]
	/** Load args from a JSON object file. */
	args?: string
	/** Write the eval result to a file. */
	out?: string
}

/** Values both eval commands derive from {@link EvalCommonOptions}. */
export type EvalCommonFlags = {
	/** Retry attempts. `parseRetryCount` defaults this to 0, so it is never absent. */
	retryCount: number
	intervalMs: number | undefined
	count: number | undefined
	timeoutMs: number | undefined
}

/**
 * Parse the flags both eval commands share, reporting the first failure.
 *
 * Each command used to walk the same six-rung parse-warn-exit ladder inline.
 *
 * @returns The parsed values, or `null` when a warning has been written and
 *   `process.exitCode` set.
 */
export const parseEvalCommonFlags = (options: EvalCommonOptions, output: Output): EvalCommonFlags | null => {
	const retryCount = parseRetryCount(options.retry)
	const intervalMs = parseIntervalMs(options.interval)
	const count = parseCount(options.count)
	const timeoutMs = parseTimeoutMs(options.timeout)

	for (const parsed of [retryCount, intervalMs, count, timeoutMs]) {
		if (parsed.error) {
			output.writeWarn(parsed.error)
			process.exitCode = 2
			return null
		}
	}

	return {
		retryCount: retryCount.value,
		intervalMs: intervalMs.value,
		count: count.value,
		timeoutMs: timeoutMs.value,
	}
}
