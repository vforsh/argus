import type { Command } from 'commander'
import { createOutput, markJsonRequested } from '../output/io.js'
import { currentExitCode, setExitCode } from '../output/exitCode.js'
import { finishOutputScope, resolveDefaultMaxChars, runWithOutputScope, runWithoutOutputScope, type OutputScope } from '../output/outputScope.js'
import { parseOutputShaping } from '../output/projection.js'

/**
 * `-q/--quiet`, `--fields`, `--max-chars` on every command.
 *
 * Agents generalize flags across commands: in one week `screenshot -q`, `page emulation -q`,
 * `net body --max-chars`, and `start --fields` all failed with `invalid_request` because only
 * `eval`/`logs`/`net`/actions declared them. A command that already declares a flag keeps its own
 * meaning; the rest get the generic one, applied by {@link runWithUniversalOutput}.
 */
type UniversalFlag = 'quiet' | 'fields' | 'maxChars'

const owned = new WeakMap<Command, ReadonlySet<UniversalFlag>>()

/** Declare whichever universal flags `command` does not declare itself. */
export const addUniversalOutputOptions = (command: Command): void => {
	const has = (flag: string): boolean => command.options.some((option) => option.long === flag || option.short === flag)
	const flags = new Set<UniversalFlag>()

	if (!has('--quiet') && !has('-q') && !has('--silent')) {
		command.option('-q, --quiet', 'Print nothing on success; errors still print')
		flags.add('quiet')
	}
	if (has('--json') && !has('--fields')) {
		command.option('--fields <paths>', 'Keep only these comma-separated dot paths of the JSON output (implies --json)')
		flags.add('fields')
	}
	if (!has('--max-chars')) {
		command.option('--max-chars <n>', 'Cap output at N characters; truncation is marked explicitly')
		flags.add('maxChars')
	}

	owned.set(command, flags)
}

/**
 * Commands that stream until interrupted: a cap meant for one answer would silence them.
 * Paths are canonical names (aliases resolved).
 */
const STREAMING_COMMANDS = new Set([
	'start',
	'session',
	'run',
	'chrome start',
	'watcher start',
	'watcher native-host',
	'logs tail',
	'net tail',
	'net sse',
	'net ws tail',
	'android attach',
])

type UniversalOptions = { quiet?: boolean; fields?: string; maxChars?: string; json?: boolean; detach?: boolean; interval?: string; verbose?: boolean }

/** Run a command body under the generic output flags and the piped default cap. */
export const runWithUniversalOutput = async (command: Command, options: Record<string, unknown>, body: () => Promise<void>): Promise<void> => {
	const flags = owned.get(command) ?? new Set<UniversalFlag>()
	const values = options as UniversalOptions
	const explicitMaxChars = command.getOptionValueSource('maxChars') === 'cli'

	const genericFields = flags.has('fields') ? values.fields : undefined
	const genericMaxChars = flags.has('maxChars') ? values.maxChars : undefined
	let fields: OutputScope['fields']
	let maxChars: number | undefined
	if (genericFields !== undefined || genericMaxChars !== undefined) {
		// `--fields` selects from the JSON document, so asking for it asks for JSON — including the
		// one-shot `ok: false` fallback, which otherwise keys off a literal `--json` in argv.
		if (genericFields !== undefined) markJsonRequested()
		const shaping = parseOutputShaping({ fields: genericFields, maxChars: genericMaxChars }, createOutput({ json: values.json === true || genericFields !== undefined }))
		if (!shaping) {
			setExitCode(2)
			return
		}
		;({ fields, maxChars } = shaping)
		if (fields) options.json = true
	}

	const defaultCap = explicitMaxChars || isStreaming(command, values) ? undefined : resolveDefaultMaxChars()
	const quiet = flags.has('quiet') && values.quiet === true
	if (!quiet && !fields && maxChars === undefined && defaultCap === undefined) {
		// A command nested in another's run (`argus run` steps) must not inherit the outer scope:
		// its output belongs to its own capture, not to the outer command's held or capped stdout.
		await runWithoutOutputScope(body)
		return
	}

	const scope: OutputScope = {
		quiet,
		fields,
		// A command with its own `--max-chars` already shaped its output to the typed budget.
		humanMaxChars: maxChars ?? defaultCap,
		defaultCap: maxChars === undefined,
		jsonMaxChars: maxChars,
		used: 0,
		omitted: 0,
		held: [],
	}

	let threw = true
	try {
		await runWithOutputScope(scope, body)
		threw = false
	} finally {
		finishOutputScope(scope, threw || currentExitCode() !== 0)
	}
}

const isStreaming = (command: Command, options: UniversalOptions): boolean => {
	const path = commandPath(command)
	// `start --detach` returns once the watcher is up; only the foreground form streams.
	if (path === 'start' && options.detach === true) return false
	// Polling forms report every iteration for as long as they run.
	if (path === 'eval' && options.interval !== undefined) return true
	if (path === 'eval-until' && options.verbose === true) return true
	return STREAMING_COMMANDS.has(path)
}

const commandPath = (command: Command): string => {
	const names: string[] = []
	for (let current: Command | null = command; current?.parent; current = current.parent) {
		names.unshift(current.name())
	}
	return names.join(' ')
}
