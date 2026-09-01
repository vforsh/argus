import type { Command, Option } from 'commander'
import type { ArgusErrorCode, SessionRequest } from '@vforsh/argus-core'

/** A `cmd` string resolved against the live command tree. */
export type ResolvedSessionCommand = {
	ok: true
	command: Command
	/** Canonical command path (aliases resolved), e.g. `['dom', 'tree']`. */
	path: string[]
}

/** Why a request could not be turned into an argv. */
export type SessionArgvFailure = {
	ok: false
	code: ArgusErrorCode
	message: string
}

export type SessionArgvSuccess = {
	ok: true
	argv: string[]
	resolved: ResolvedSessionCommand
}

/**
 * Resolve a space-separated `cmd` against the registered command tree.
 *
 * Aliases resolve like they do on the command line (`js` → `eval`, `ext` → `extension`),
 * so a host can paste the command it already types.
 */
export const resolveSessionCommand = (program: Command, cmd: string): ResolvedSessionCommand | SessionArgvFailure => {
	const tokens = cmd.trim().split(/\s+/).filter(Boolean)
	if (tokens.length === 0) {
		return { ok: false, code: 'session_invalid_request', message: 'cmd must name a command' }
	}

	let current = program
	const path: string[] = []
	for (const token of tokens) {
		const next = current.commands.find((candidate) => candidate.name() === token || candidate.aliases().includes(token))
		if (!next) {
			const context = path.length > 0 ? ` under "${path.join(' ')}"` : ''
			return { ok: false, code: 'session_unknown_command', message: `Unknown command "${token}"${context}.` }
		}
		current = next
		path.push(next.name())
	}

	return { ok: true, command: current, path }
}

/**
 * Turn one session request into the argv the CLI would have been spawned with.
 *
 * Everything is derived from the command's own Commander definition rather than a
 * hand-kept table: option names, whether an option takes a value, which positionals exist,
 * and whether `--json` is even declared. A command added elsewhere in the CLI — or by a
 * plugin — becomes reachable over the session with no change here.
 */
export const buildSessionArgv = (input: {
	program: Command
	request: SessionRequest
	/** Watcher the session is pinned to, injected as the leading `[id]` argument. */
	watcherId: string
}): SessionArgvSuccess | SessionArgvFailure => {
	const resolved = resolveSessionCommand(input.program, input.request.cmd)
	if (!resolved.ok) {
		return resolved
	}

	const blocked = rejectNonSessionCommand(resolved.path)
	if (blocked) {
		return blocked
	}

	const tail = input.request.argv ? [...input.request.argv] : buildArgvFromArgs(resolved.command, input.request.args ?? {})
	if (isArgvFailure(tail)) {
		return tail
	}

	const argv = [...resolved.path]
	if (takesWatcherId(resolved.command) && tail[0] !== input.watcherId) {
		argv.push(input.watcherId)
	}
	argv.push(...tail)

	if (declaresOption(resolved.command, 'json') && !tail.some(isJsonFlag)) {
		argv.push('--json')
	}

	const rejected = rejectStdinInput(argv, resolved.path)
	if (rejected) {
		return rejected
	}

	return { ok: true, argv, resolved }
}

/**
 * Commands that never return on their own, and so cannot be a request/response pair.
 *
 * Daemons (`start`, `watcher start`) also call `process.exit` directly, which would take the
 * session down with them; the tails block until interrupted. Run these as their own process
 * and drive the resulting watcher from the session.
 */
const NON_SESSION_COMMANDS = new Set(['session', 'start', 'chrome start', 'watcher start', 'watcher native-host', 'logs tail', 'net tail', 'net sse'])

const rejectNonSessionCommand = (path: readonly string[]): SessionArgvFailure | null => {
	const name = path.join(' ')
	if (!NON_SESSION_COMMANDS.has(name)) {
		return null
	}
	return {
		ok: false,
		code: 'session_command_rejected',
		message: `"${name}" runs until interrupted and cannot be dispatched from a session; run it as its own process.`,
	}
}

/**
 * Reject the two spellings that would read the stream the transport owns.
 *
 * `-` only means "read stdin" for the eval commands; elsewhere it is an ordinary value, so
 * the check is scoped rather than applied to every argv.
 */
const rejectStdinInput = (argv: readonly string[], path: readonly string[]): SessionArgvFailure | null => {
	const readsStdin = argv.includes('--stdin') || (STDIN_DASH_COMMANDS.has(path[0]) && argv.includes('-'))
	if (!readsStdin) {
		return null
	}
	return {
		ok: false,
		code: 'session_command_rejected',
		message: 'stdin belongs to the session transport; pass the expression inline or with --file instead of reading stdin.',
	}
}

const STDIN_DASH_COMMANDS = new Set(['eval', 'eval-until'])

/** Narrow the `tokens | failure` results the builders below return. */
const isArgvFailure = (value: string[] | SessionArgvFailure): value is SessionArgvFailure => !Array.isArray(value)

const isJsonFlag = (token: string): boolean => token === '--json' || token === '--no-json' || token === '--json-full'

/** A command whose first declared argument is the watcher id gets it injected. */
const takesWatcherId = (command: Command): boolean => command.registeredArguments[0]?.name() === 'id'

const declaresOption = (command: Command, name: string): boolean => findOptions(command, name).length > 0

/**
 * Map a named `args` object onto CLI tokens.
 *
 * Keys match an option first (by attribute name, long flag, or short flag) and a declared
 * positional argument second, which is the same precedence the one-shot CLI applies when a
 * command offers both spellings (`argus eval app "1+1"` vs `argus eval app --expression "1+1"`).
 */
const buildArgvFromArgs = (command: Command, args: Record<string, unknown>): string[] | SessionArgvFailure => {
	const names = positionalNames(command)
	const tokens: string[] = []
	const positionals: Record<string, unknown> = {}

	for (const [key, value] of Object.entries(args)) {
		if (value === undefined) continue

		const options = findOptions(command, key)
		if (options.length === 0) {
			if (!names.includes(camelCase(key))) {
				const path = commandPath(command)
				return {
					ok: false,
					code: 'session_invalid_request',
					message: `Unknown argument "${key}" for command "${path}". Run \`argus ${path} --help\` for the accepted flags.`,
				}
			}
			positionals[camelCase(key)] = value
			continue
		}

		const emitted = emitOption(options, key, value)
		if (isArgvFailure(emitted)) {
			return emitted
		}
		tokens.push(...emitted)
	}

	const ordered = orderPositionals(names, positionals)
	if (isArgvFailure(ordered)) {
		return ordered
	}

	return [...ordered, ...tokens]
}

/** Render one `args` entry as CLI tokens, honoring value/boolean/negated/repeatable shapes. */
const emitOption = (options: readonly Option[], key: string, value: unknown): string[] | SessionArgvFailure => {
	const positive = options.find((option) => !option.negate)
	const negated = options.find((option) => option.negate)
	const valued = options.find((option) => option.required || option.optional)

	if (valued) {
		const values = Array.isArray(value) ? value : [value]
		const tokens: string[] = []
		for (const entry of values) {
			if (entry == null) continue
			if (typeof entry === 'object') {
				return { ok: false, code: 'session_invalid_request', message: `Argument "${key}" must be a string, number, or boolean.` }
			}
			tokens.push(flagOf(valued), String(entry))
		}
		return tokens
	}

	if (typeof value !== 'boolean') {
		return { ok: false, code: 'session_invalid_request', message: `Argument "${key}" is a switch and must be true or false.` }
	}

	// A switch set to its declared default needs no token: `{ bundle: false }` on a command
	// that only declares `--bundle` is already the default, and so is `{ await: true }` on one
	// that only declares `--no-await`.
	const wanted = value ? positive : negated
	return wanted ? [flagOf(wanted)] : []
}

/** Place named positionals into declaration order, rejecting gaps a CLI could not express. */
const orderPositionals = (declaredNames: readonly string[], values: Record<string, unknown>): string[] | SessionArgvFailure => {
	const tokens: string[] = []
	let missing: string | null = null

	for (const name of declaredNames) {
		if (name === 'id') continue

		const value = values[name]
		if (value === undefined) {
			missing ??= name
			continue
		}
		if (missing) {
			return {
				ok: false,
				code: 'session_invalid_request',
				message: `Argument "${name}" cannot be set without "${missing}"; positional arguments are filled in order.`,
			}
		}
		for (const entry of Array.isArray(value) ? value : [value]) {
			if (entry != null && typeof entry === 'object') {
				return { ok: false, code: 'session_invalid_request', message: `Argument "${name}" must be a string, number, or boolean.` }
			}
			tokens.push(String(entry))
		}
	}

	return tokens
}

/** Every option named `key` on the command or its ancestors, excluding the root program. */
const findOptions = (command: Command, key: string): Option[] => {
	const wanted = camelCase(key)
	return commandChain(command)
		.flatMap((current) => current.options)
		.filter((option) => option.attributeName() === wanted || option.name() === key || option.short === `-${key}`)
}

const positionalNames = (command: Command): string[] => command.registeredArguments.map((argument) => camelCase(argument.name()))

const flagOf = (option: Option): string => option.long ?? option.short ?? `--${option.name()}`

const commandPath = (command: Command): string =>
	commandChain(command)
		.map((current) => current.name())
		.reverse()
		.join(' ')

/**
 * The command and its ancestors, nearest first, stopping before the root program.
 *
 * Program-level flags (`--plugin`) belong to a one-shot invocation, not to a request the
 * session dispatches, so they stay out of both name resolution and error messages.
 */
const commandChain = (command: Command): Command[] => {
	const chain: Command[] = []
	for (let current: Command | null = command; current?.parent; current = current.parent) {
		chain.push(current)
	}
	return chain
}

const camelCase = (value: string): string => value.replace(/[-_]([a-z0-9])/g, (_, character: string) => character.toUpperCase())
