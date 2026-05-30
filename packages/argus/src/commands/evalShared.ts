import type { EvalResponse } from '@vforsh/argus-core'
import { previewStringify } from '@vforsh/argus-core'
import { readFile } from 'node:fs/promises'
import { formatError, parseNumber } from '../cli/parse.js'
import type { Output } from '../output/io.js'
import { parseDurationMs } from '../time.js'
import { type EvalArgMap, type EvalArgSourceOptions, hasEvalArgs, resolveEvalArgs } from './evalArgs.js'
import { bundleEvalEntry } from './evalBundle.js'
import { fileUsesModuleSyntax } from './evalModuleSyntax.js'
import { createEvalResultFileSink, type EvalResultFileOptions } from './evalResultOutput.js'

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

	const resolvedExpression = await resolveExpression(inline, options, output)
	if (resolvedExpression == null) {
		return null
	}

	if (!options.iframe) {
		return {
			expression: resolvedExpression,
			args: hasEvalArgs(args) ? args : undefined,
		}
	}

	const iframeTimeoutMs = parseDurationFlagMs(options.iframeTimeout, '--iframe-timeout')
	if (iframeTimeoutMs.error) {
		output.writeWarn(iframeTimeoutMs.error)
		return null
	}

	return {
		expression: wrapForIframeEval(wrapExpressionWithArgs(resolvedExpression, args), {
			selector: options.iframe,
			namespace: options.iframeNamespace ?? 'argus',
			timeoutMs: iframeTimeoutMs.value ?? 5000,
		}),
	}
}

/**
 * Resolve the JS expression from inline argument, --file, or --stdin.
 * Returns `null` (and writes a warning) when the input is invalid.
 */
export const resolveExpression = async (inline: string | undefined, options: ExpressionSourceOptions, output: Output): Promise<string | null> => {
	const wantsStdin = options.stdin === true || inline === '-'
	const hasInline = inline != null && inline !== '-'
	const filePath = options.file
	const hasFile = filePath != null

	if (hasInline && hasFile) {
		output.writeWarn('Cannot combine an inline expression with --file')
		return null
	}

	if (hasInline && wantsStdin) {
		output.writeWarn('Cannot combine an inline expression with --stdin')
		return null
	}

	if (hasFile && wantsStdin) {
		output.writeWarn('Cannot combine --file with stdin input')
		return null
	}

	if ((options.bundle || options.noBundle) && !hasFile) {
		output.writeWarn('--bundle and --no-bundle require --file')
		return null
	}

	let expression: string
	if (hasFile) {
		const fileContent = await readFileContent(filePath, options.file, output)
		if (fileContent == null) {
			return null
		}

		const bundleDecision = resolveBundleDecision(options, fileContent)
		if (bundleDecision.autoEnabled) {
			output.writeWarn('Detected import/export in --file; bundling automatically. Pass --no-bundle to read the file as-is.')
		}

		if (bundleDecision.shouldBundle) {
			const bundled = await bundleEvalEntry(filePath)
			if (!bundled.ok) {
				output.writeWarn(`Failed to bundle --file: ${bundled.error}`)
				return null
			}

			if (!bundled.code.trim()) {
				output.writeWarn(`Bundled file is empty: ${options.file}`)
				return null
			}

			expression = bundled.code
		} else {
			expression = fileContent
		}
	} else if (wantsStdin) {
		try {
			const content = await readStdin()
			if (!content.trim()) {
				output.writeWarn('Stdin input is empty')
				return null
			}
			expression = content
		} catch (error) {
			output.writeWarn(`Failed to read stdin: ${formatError(error)}`)
			return null
		}
	} else if (hasInline) {
		if (!inline.trim()) {
			output.writeWarn('Expression is empty')
			return null
		}
		expression = inline
	} else {
		output.writeWarn('Expression is required. Provide an inline expression, --file, or --stdin (or pass - as expression).')
		return null
	}

	return await prependInjectSource(expression, options.inject, output)
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

const readFileContent = async (filePath: string, displayPath: string | undefined, output: Output): Promise<string | null> => {
	try {
		const content = await readFile(filePath, 'utf8')
		if (!content.trim()) {
			output.writeWarn(`File is empty: ${displayPath}`)
			return null
		}

		return content
	} catch (error) {
		output.writeWarn(`Failed to read --file: ${formatError(error)}`)
		return null
	}
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

/** Read all of stdin into a string. */
export const readStdin = async (): Promise<string> =>
	new Promise((resolve, reject) => {
		let data = ''
		process.stdin.setEncoding('utf8')
		process.stdin.on('data', (chunk) => {
			data += chunk
		})
		process.stdin.on('end', () => resolve(data))
		process.stdin.on('error', (error) => reject(error))
		process.stdin.resume()
	})

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
// Timing
// ---------------------------------------------------------------------------

/** Sleep for `durationMs` milliseconds. */
export const sleep = async (durationMs: number): Promise<void> => {
	await new Promise((resolve) => setTimeout(resolve, durationMs))
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
