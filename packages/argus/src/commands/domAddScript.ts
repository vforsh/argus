import { readFile } from 'node:fs/promises'
import { evalOnce } from '../eval/evalClient.js'
import { createOutput } from '../output/io.js'
import { formatError } from '../cli/parse.js'
import { resolvePath } from '../utils/paths.js'
import { resolveWatcherOrExit } from '../watchers/requestWatcher.js'

/** Options for the dom add-script command. */
export type DomAddScriptOptions = {
	src?: string
	file?: string
	stdin?: boolean
	type?: string
	/** Script element id attribute (mapped from CLI --id to avoid clash with watcher id positional). */
	scriptId?: string
	target?: string
	json?: boolean
}

/** Execute the dom add-script command for a watcher id. */
export const runDomAddScript = async (id: string | undefined, code: string | undefined, options: DomAddScriptOptions): Promise<void> => {
	const output = createOutput(options)

	const target = resolveTarget(options.target, output)
	if (!target) {
		process.exitCode = 2
		return
	}

	const input = await resolveCodeInput(code, options, output)
	if (!input) {
		process.exitCode = 2
		return
	}

	const resolved = await resolveWatcherOrExit({ id }, output)
	if (!resolved) return

	const { watcher } = resolved

	const scriptConfig = {
		type: options.type,
		id: options.scriptId,
		target,
	}

	const isSrc = input.kind === 'src'
	const expression = isSrc ? buildSrcScriptExpression(input.value, scriptConfig) : buildInlineScriptExpression(input.value, scriptConfig)

	const result = await evalOnce({
		watcher,
		expression,
		awaitPromise: isSrc,
		returnByValue: true,
		failOnException: true,
	})

	if (!result.ok) {
		if (options.json && result.response) {
			output.writeJson(result.response)
		}
		if (result.kind === 'exception' && result.response?.exception) {
			output.writeWarn(`Exception: ${result.response.exception.text}`)
		} else {
			output.writeWarn(result.error)
		}
		process.exitCode = 1
		return
	}

	if (options.json) {
		output.writeJson(result.response)
		return
	}

	const prefix = watcher.id ? `${watcher.id}: ` : ''
	if (isSrc) {
		output.writeHuman(`${prefix}Script loaded from ${input.value} into <${target}>`)
	} else {
		output.writeHuman(`${prefix}Script added to <${target}>`)
	}
}

type CodeInput = { kind: 'inline'; value: string } | { kind: 'src'; value: string }

const resolveCodeInput = async (
	code: string | undefined,
	options: DomAddScriptOptions,
	output: ReturnType<typeof createOutput>,
): Promise<CodeInput | null> => {
	const wantsStdin = options.stdin === true || code === '-'
	const hasInline = code != null && code !== '-'
	const hasFile = options.file != null
	const hasSrc = options.src != null

	const sourceCount = [hasInline, hasFile, wantsStdin, hasSrc].filter(Boolean).length
	if (sourceCount > 1) {
		output.writeWarn('Provide only one of: inline code, --file, --stdin, or --src')
		return null
	}

	if (hasSrc) {
		const url = options.src!.trim()
		if (!url) {
			output.writeWarn('--src value is empty')
			return null
		}
		return { kind: 'src', value: url }
	}

	if (hasFile) {
		try {
			const content = await readFile(resolvePath(options.file!), 'utf8')
			if (!content.trim()) {
				output.writeWarn(`File is empty: ${options.file}`)
				return null
			}
			return { kind: 'inline', value: content }
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
			return { kind: 'inline', value: content }
		} catch (error) {
			output.writeWarn(`Failed to read stdin: ${formatError(error)}`)
			return null
		}
	}

	if (hasInline) {
		if (!code!.trim()) {
			output.writeWarn('Code is empty')
			return null
		}
		return { kind: 'inline', value: code! }
	}

	output.writeWarn('Provide inline code, --file, --stdin (or pass - as code), or --src.')
	return null
}

type ScriptConfig = {
	type?: string
	id?: string
	target: string
}

const buildInlineScriptExpression = (code: string, config: ScriptConfig): string => {
	const doubleEncoded = JSON.stringify(JSON.stringify(code))
	const attrs = buildAttrLines(config)
	return `(() => {
  const s = document.createElement('script');
  s.textContent = JSON.parse(${doubleEncoded});${attrs}
  document.${config.target}.appendChild(s);
  return { ok: true, target: ${JSON.stringify(config.target)} };
})()`
}

const buildSrcScriptExpression = (url: string, config: ScriptConfig): string => {
	const attrs = buildAttrLines(config)
	return `(() => {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = ${JSON.stringify(url)};${attrs}
    s.onload = () => resolve({ ok: true, src: s.src, target: ${JSON.stringify(config.target)} });
    s.onerror = () => reject(new Error('Failed to load script: ' + s.src));
    document.${config.target}.appendChild(s);
  });
})()`
}

const buildAttrLines = (config: ScriptConfig): string => {
	let lines = ''
	if (config.type) {
		lines += `\n  s.type = ${JSON.stringify(config.type)};`
	}
	if (config.id) {
		lines += `\n  s.id = ${JSON.stringify(config.id)};`
	}
	return lines
}

const resolveTarget = (value: string | undefined, output: ReturnType<typeof createOutput>): string | null => {
	if (!value) {
		return 'head'
	}

	const normalized = value.trim().toLowerCase()
	if (normalized === 'head' || normalized === 'body') {
		return normalized
	}

	output.writeWarn('--target must be "head" or "body"')
	return null
}

const readStdin = async (): Promise<string> =>
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
