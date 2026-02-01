import type { EvalResponse } from '@vforsh/argus-core'
import { previewStringify } from '@vforsh/argus-core'
import { readFile } from 'node:fs/promises'
import { formatError, parseNumber } from '../cli/parse.js'
import type { Output } from '../output/io.js'
import { parseDurationMs } from '../time.js'

// Re-export shared parsers so existing eval imports keep working
export { formatError, parseNumber } from '../cli/parse.js'

// ---------------------------------------------------------------------------
// Expression resolution
// ---------------------------------------------------------------------------

type ExpressionSourceOptions = {
	file?: string
	stdin?: boolean
}

/**
 * Resolve the JS expression from inline argument, --file, or --stdin.
 * Returns `null` (and writes a warning) when the input is invalid.
 */
export const resolveExpression = async (inline: string | undefined, options: ExpressionSourceOptions, output: Output): Promise<string | null> => {
	const wantsStdin = options.stdin === true || inline === '-'
	const hasInline = inline != null && inline !== '-'
	const hasFile = options.file != null

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

	if (hasFile) {
		try {
			const content = await readFile(options.file ?? '', 'utf8')
			if (!content.trim()) {
				output.writeWarn(`File is empty: ${options.file}`)
				return null
			}
			return content
		} catch (error) {
			output.writeWarn(`Failed to read --file: ${formatError(error)}`)
			return null
		}
	}

	if (wantsStdin) {
		try {
			const content = await readStdin()
			if (!content.trim()) {
				output.writeWarn('Stdin input is empty')
				return null
			}
			return content
		} catch (error) {
			output.writeWarn(`Failed to read stdin: ${formatError(error)}`)
			return null
		}
	}

	if (hasInline) {
		if (!inline.trim()) {
			output.writeWarn('Expression is empty')
			return null
		}
		return inline
	}

	output.writeWarn('Expression is required. Provide an inline expression, --file, or --stdin (or pass - as expression).')
	return null
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
	if (value == null) {
		return {}
	}

	const trimmed = value.trim()
	if (!trimmed) {
		return { error: 'Invalid --interval value: empty duration.' }
	}

	let parsed: number | null
	if (/^[0-9]+$/.test(trimmed)) {
		parsed = Number(trimmed)
	} else {
		parsed = parseDurationMs(trimmed)
	}

	if (parsed == null || !Number.isFinite(parsed) || parsed <= 0) {
		return { error: 'Invalid --interval value: expected milliseconds or a duration like 250ms, 3s, 2m.' }
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

/** Failure shape used by `printError`. */
export type EvalAttemptFailure = {
	ok: false
	kind: 'transport' | 'exception'
	error: string
	response?: EvalResponse
	attempt: number
}

type PrintableEvalOptions = {
	json?: boolean
	silent?: boolean
}

/** Print a successful eval response. */
export const printSuccess = (response: EvalResponse, options: PrintableEvalOptions, output: Output, streaming: boolean): void => {
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

/** Print an eval error (transport, exception, or until-condition failure). */
export const printError = (error: EvalAttemptFailure | { kind: 'until'; error: string }, options: PrintableEvalOptions, output: Output): void => {
	if (options.json && 'response' in error && error.response) {
		output.writeJsonLine(error.response)
	}

	if (error.kind === 'exception' && 'response' in error && error.response?.exception) {
		output.writeWarn(formatException(error.response))
		return
	}

	output.writeWarn(error.error)
}

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
