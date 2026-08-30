import { evalOnce } from '../eval/evalClient.js'
import { createOutput } from '../output/io.js'
import { resolveWatcherOrExit } from '../watchers/requestWatcher.js'
import { readTextInput, selectTextInput } from './inputSource.js'

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
	// `--src` wins outright when it is the only source; otherwise it just joins the conflict message.
	const hasSrc = options.src != null
	const hasTextSource = options.file != null || options.stdin === true || (code != null && code !== '-')
	if (hasSrc && !hasTextSource) {
		const url = options.src!.trim()
		if (!url) {
			output.writeWarn('--src value is empty')
			return null
		}
		return { kind: 'src', value: url }
	}

	const selection = selectTextInput(
		{ inline: code, file: options.file, stdin: options.stdin },
		{
			inline: 'inline code',
			file: '--file',
			stdin: '--stdin',
			missing: 'Code is required. Provide inline code, --file, --stdin, or --src (or pass - as code).',
		},
		output,
		[{ name: '--src', present: hasSrc }],
	)
	if (!selection) {
		return null
	}

	const value = await readTextInput(selection, { file: '--file' }, output, 'Code')
	return value == null ? null : { kind: 'inline', value }
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
