import { readFile } from 'node:fs/promises'
import type { Command } from 'commander'
import type { SessionResponse } from '@vforsh/argus-core'
import { createWatcherResolver, formatError } from '@vforsh/argus-core'
import { usageError } from '../cli/validation.js'
import { createOutput, routeConsoleToStderr } from '../output/io.js'
import { currentExitCode, setExitCode } from '../output/exitCode.js'
import { resolvePath } from '../utils/paths.js'
import { resolveWatcherOrExit } from '../watchers/requestWatcher.js'
import { withPinnedWatcher, withWatcherResolver } from '../watchers/resolveWatcher.js'
import { buildSessionProgram } from './runSession.js'
import { dispatchSessionRequest } from './sessionDispatch.js'
import { installStdioCapture } from './stdioCapture.js'

export type RunScriptOptions = {
	file?: string
	json?: boolean
	keepGoing?: boolean
}

/** Per-step watchdog; a step's own `--timeout`/`--until-timeout` still applies inside it. */
const STEP_TIMEOUT_MS = 120_000

/** One parsed script line. */
type ScriptStep = { step: number; line: string; tokens: string[] }

type StepReport = {
	step: number
	line: string
	ok: boolean
	durationMs: number
	result?: unknown
	error?: { message: string; code?: string }
}

/**
 * `argus run <id>`: execute CLI-syntax lines against one watcher, in one process.
 *
 * 640 observed agent shell calls chained three or more `argus` invocations with `;` and `sleep`;
 * `argus session` could have run them in one process but asks for a JSONL protocol nobody wrote.
 * Here each line is what the agent would have typed after `argus` (the watcher id may be left out),
 * steps stop at the first failure, and the output is one compact line per step.
 */
export const runScript = async (id: string | undefined, options: RunScriptOptions): Promise<void> => {
	const output = createOutput(options)

	const source = await readScript(options)
	if (source == null) return

	const parsed = parseScript(source)
	if ('error' in parsed) {
		usageError(options, parsed.error)
		return
	}
	if (parsed.steps.length === 0) {
		usageError(options, 'The script has no commands. Write one argus command per line, e.g. `click --selector "#save" --settle`.')
		return
	}

	const resolved = await resolveWatcherOrExit({ id }, output)
	if (!resolved) return
	const watcherId = resolved.watcher.id

	// Steps write into a capture; incidental console output of plugins must not reach our stdout.
	routeConsoleToStderr()
	const { program, plugins } = await buildSessionProgram()
	const capture = installStdioCapture()

	const reports: StepReport[] = []
	// A step its watchdog gave up on may still be running and writing; see the end of this function.
	let abandoned = false
	// Commands that take the watcher in a later positional (`net mock rm <id> [watcher]`) resolve it
	// without an id; pinning keeps them on this watcher instead of cwd-based discovery.
	await withWatcherResolver(createWatcherResolver(), () =>
		withPinnedWatcher(watcherId, async () => {
			for (const step of parsed.steps) {
				// Load a deferred plugin before splitting, or its subcommands are not in the tree yet.
				await plugins.prepare(step.tokens)
				const split = splitCommand(program, step.tokens)
				const response = await dispatchSessionRequest({
					program,
					capture,
					request: { id: step.step, cmd: split.cmd, argv: split.argv },
					watcherId,
					defaultTimeoutMs: STEP_TIMEOUT_MS,
					ownsProcessExitCode: true,
				})
				const report = toReport(step, response)
				reports.push(report)
				if (!output.json) output.writeHuman(formatStep(report))
				if (!response.ok && response.error.code === 'session_request_timeout') {
					abandoned = true
					break
				}
				if (!report.ok && !options.keepGoing) break
			}
		}),
	)

	const failed = reports.filter((report) => !report.ok)
	if (failed.length > 0) setExitCode(1)

	if (output.json) {
		output.writeJson({
			ok: failed.length === 0,
			watcher: watcherId,
			steps: reports,
			...(failed.length > 0 ? { error: { message: `Step ${failed[0].step} failed: ${failed[0].error?.message ?? 'command failed'}`, code: 'run_step_failed' } } : {}),
		})
	} else if (failed.length > 0) {
		const stoppedEarly = reports.length < parsed.steps.length
		output.writeWarn(`${reports.length - failed.length}/${parsed.steps.length} steps ok; ${stoppedEarly ? `stopped at step ${reports.at(-1)?.step}` : 'finished with failures'}`)
	}
	finishCapture(capture, abandoned)
}

/**
 * Release stdout once the report is out.
 *
 * Normally the capture just goes. After a step timed out, its abandoned command may still write or
 * hold sockets open, so the capture stays (late writes land in that step's own sink) and the process
 * exits once the outer command flushed its output, as `argus session` does.
 */
const finishCapture = (capture: ReturnType<typeof installStdioCapture>, abandoned: boolean): void => {
	if (!abandoned) {
		capture.restore()
		return
	}
	setTimeout(() => {
		process.stdout.write('', () => process.exit(currentExitCode() || 1))
	}, 0)
}

const readScript = async (options: RunScriptOptions): Promise<string | null> => {
	if (options.file) {
		try {
			return await readFile(resolvePath(options.file), 'utf8')
		} catch (error) {
			usageError(options, `Cannot read --file: ${formatError(error)}`)
			return null
		}
	}
	if (process.stdin.isTTY) {
		usageError(options, 'Pass the script on stdin (heredoc or pipe) or with --file <path>.')
		return null
	}
	const chunks: Buffer[] = []
	for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
	return Buffer.concat(chunks).toString('utf8')
}

/**
 * Split a script into steps: one command per line, `#` comments, `\` line continuations, shell-style
 * quoting (`'…'` literal, `"…"` with `\"`/`\\` escapes). A leading `argus` is dropped, so lines can be
 * pasted from a shell history.
 */
export const parseScript = (source: string): { steps: ScriptStep[] } | { error: string } => {
	const steps: ScriptStep[] = []
	const lines = source.split(/\r?\n/)
	for (let index = 0; index < lines.length; index += 1) {
		let line = lines[index]
		while (/(^|[^\\])\\$/.test(line) && index + 1 < lines.length) {
			index += 1
			line = `${line.slice(0, -1)} ${lines[index]}`
		}
		const trimmed = line.trim()
		if (trimmed === '' || trimmed.startsWith('#')) continue

		const tokens = tokenize(trimmed)
		if ('error' in tokens) return { error: `Line ${index + 1}: ${tokens.error}` }
		if (tokens.value[0] === 'argus') tokens.value.shift()
		if (tokens.value.length === 0) continue
		steps.push({ step: steps.length + 1, line: trimmed.replace(/^argus\s+/, ''), tokens: tokens.value })
	}
	return { steps }
}

const tokenize = (line: string): { value: string[] } | { error: string } => {
	const tokens: string[] = []
	let current = ''
	let started = false
	let quote: '"' | "'" | null = null

	for (let index = 0; index < line.length; index += 1) {
		const char = line[index]
		if (quote === "'") {
			if (char === "'") quote = null
			else current += char
			continue
		}
		if (quote === '"') {
			if (char === '"') quote = null
			else if (char === '\\' && index + 1 < line.length && '"\\$`'.includes(line[index + 1])) current += line[++index]
			else current += char
			continue
		}
		if (char === "'" || char === '"') {
			quote = char
			started = true
			continue
		}
		if (char === '\\' && index + 1 < line.length) {
			current += line[++index]
			started = true
			continue
		}
		if (/\s/.test(char)) {
			if (started) tokens.push(current)
			current = ''
			started = false
			continue
		}
		if (char === '#' && !started) break
		current += char
		started = true
	}
	if (quote) return { error: `unterminated ${quote} quote` }
	if (started) tokens.push(current)
	return { value: tokens }
}

/** Longest leading run of tokens that names a command (`page emulation clear`), the rest is its argv. */
const splitCommand = (program: Command, tokens: readonly string[]): { cmd: string; argv: string[] } => {
	const path: string[] = []
	let current = program
	let index = 0
	for (; index < tokens.length; index += 1) {
		const next = current.commands.find((candidate) => candidate.name() === tokens[index] || candidate.aliases().includes(tokens[index]))
		if (!next) break
		path.push(next.name())
		current = next
	}
	// An unknown first word still goes through dispatch, which answers `session_unknown_command`.
	if (path.length === 0) return { cmd: tokens[0], argv: [...tokens.slice(1)] }
	return { cmd: path.join(' '), argv: [...tokens.slice(index)] }
}

const toReport = (step: ScriptStep, response: SessionResponse): StepReport => {
	const base = { step: step.step, line: step.line, durationMs: response.durationMs }
	if (response.ok) return { ...base, ok: true, result: response.result }
	return { ...base, ok: false, error: { message: response.error.message, ...(response.error.code ? { code: response.error.code } : {}) } }
}

/** `✓ 2 click --selector #save (412ms) → {"clicked":1}`: bounded so a page dump cannot flood the summary. */
const formatStep = (report: StepReport): string => {
	const head = `${report.ok ? '✓' : '✗'} ${report.step} ${report.line} (${report.durationMs}ms)`
	if (!report.ok) return `${head}: ${report.error?.message ?? 'failed'}${report.error?.code ? ` [${report.error.code}]` : ''}`
	const preview = previewResult(report.result)
	return preview ? `${head} → ${preview}` : head
}

const PREVIEW_CHARS = 300

const previewResult = (result: unknown): string => {
	let value = result
	if (value != null && typeof value === 'object' && !Array.isArray(value)) {
		const record = value as Record<string, unknown>
		// `{ ok: true, result }` (eval) shows the value; other documents drop the redundant `ok`.
		if ('result' in record && record.ok === true) value = record.result
		else value = Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'ok'))
	}
	if (value == null || (typeof value === 'object' && Object.keys(value).length === 0)) return ''
	const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '')
	return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}… (${text.length} chars)` : text
}
