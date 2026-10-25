import type { Command } from 'commander'

const HELP_FLAGS = new Set(['-h', '--help'])

type UnknownCommand = {
	name: string
	/** Indexes of `--help`/`-h` and `help` command tokens that would otherwise mask the error. */
	helpIndexes: number[]
}

/**
 * Make an unknown command fail even when help is requested.
 *
 * Commander checks the help flag before it rejects an unknown subcommand, so `argus emulation --help`
 * printed root help and exited 0, and `argus help emulation` printed root help as an error. Resolve
 * the command path first: when it stops at a name that is not a subcommand, drop the help tokens so
 * Commander reports `unknown command` (with its sibling suggestion), or report it here when the name
 * is a subcommand elsewhere in the tree (`argus page emulation`).
 *
 * @param program Fully registered command tree (core and plugin commands).
 * @param args User arguments, without the node and script entries.
 * @returns The arguments Commander should parse; unchanged unless help tokens masked an unknown command.
 * @throws Through `program.error` (the program's exit override) when a nested command matches the name.
 */
export const guardUnknownCommand = (program: Command, args: string[]): string[] => {
	const unknown = findUnknownCommand(program, args)
	if (!unknown) return args

	const nested = findNestedCommandPaths(program, unknown.name)
	if (nested.length) {
		program.error(`error: unknown command '${unknown.name}'\n(Did you mean ${nested.join(' or ')}?)`, {
			code: 'commander.unknownCommand',
		})
	}

	if (!unknown.helpIndexes.length) return args
	const masked = new Set(unknown.helpIndexes)
	return args.filter((_, index) => !masked.has(index))
}

/**
 * Walk the arguments the way Commander dispatches them and return the first operand that should name a
 * subcommand but does not. Stops (returns `null`) wherever Commander would stop dispatching: an unknown
 * option, a leading help flag, `--`, or a command that takes positional arguments.
 */
const findUnknownCommand = (program: Command, args: string[]): UnknownCommand | null => {
	const helpIndexes: number[] = []
	let command = program

	for (let index = 0; index < args.length; index++) {
		const token = args[index]!
		if (token === '--' || HELP_FLAGS.has(token)) return null
		if (token.startsWith('-')) {
			const valueCount = optionValueCount(command, token, args[index + 1])
			if (valueCount == null) return null
			index += valueCount
			continue
		}

		if (!command.commands.length) return null
		const subcommand = findSubcommand(command, token)
		if (subcommand) {
			command = subcommand
			continue
		}
		if (token === 'help' && hasHelpCommand(command)) {
			helpIndexes.push(index)
			continue
		}
		if (command.registeredArguments.length) return null

		for (let rest = index + 1; rest < args.length && args[rest] !== '--'; rest++) {
			if (HELP_FLAGS.has(args[rest]!)) helpIndexes.push(rest)
		}
		return { name: token, helpIndexes }
	}

	return null
}

/** Tokens consumed after a known option (0 or 1), or `null` for an option Commander would not recognize here. */
const optionValueCount = (command: Command, token: string, next: string | undefined): number | null => {
	const flag = token.split('=')[0]!
	const option = command.options.find((candidate) => candidate.long === flag || candidate.short === flag)
	if (!option) return null
	if (token.includes('=') || (!option.required && !option.optional)) return 0
	if (option.optional && (next == null || next.startsWith('-'))) return 0
	return 1
}

const findSubcommand = (command: Command, name: string): Command | undefined => command.commands.find((candidate) => isNamed(candidate, name))

const isNamed = (command: Command, name: string): boolean => command.name() === name || command.aliases().includes(name)

/** Commander adds an implicit `help` subcommand to commands with subcommands and no action. */
const hasHelpCommand = (command: Command): boolean =>
	command
		.createHelp()
		.visibleCommands(command)
		.some((candidate) => !command.commands.includes(candidate))

/** Full invocation paths (`argus page emulation`) of visible commands named or aliased `name`. */
const findNestedCommandPaths = (program: Command, name: string): string[] => {
	const paths: string[] = []
	const visit = (command: Command, path: string): void => {
		for (const child of visibleSubcommands(command)) {
			const childPath = `${path} ${child.name()}`
			if (isNamed(child, name)) paths.push(`'${childPath}'`)
			visit(child, childPath)
		}
	}
	visit(program, program.name())
	return paths
}

/** Non-hidden registered subcommands, without Commander's implicit `help`. */
const visibleSubcommands = (command: Command): Command[] =>
	command
		.createHelp()
		.visibleCommands(command)
		.filter((candidate) => command.commands.includes(candidate))
