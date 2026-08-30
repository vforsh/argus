import { Command } from 'commander'

export type ArgusCommandOption = {
	flags: string
	description: string
	defaultValue?: string | boolean | string[]
	required?: boolean
	/** Custom Commander argParser, e.g. accumulating repeatable flags into an array. */
	parser?: (value: string, previous: any) => any
}

export type ArgusCommandDefinition = {
	name: string
	alias?: string
	aliases?: readonly string[]
	description?: string
	arguments?: readonly { flags: string; description: string }[]
	options?: readonly ArgusCommandOption[]
	examples?: readonly string[]
	configure?: (command: Command) => void
	/**
	 * Command body. Always invoked as `(...declaredArgs, options, command)`.
	 *
	 * `options` is `optsWithGlobals()`, so a subcommand already sees its parent's flags
	 * merged in — register files must not re-derive that themselves.
	 *
	 * The parameter list stays `any[]` on purpose: arity varies per command, and under
	 * `strictFunctionTypes` a `unknown[]` rest would reject every action that names its
	 * own parameters, forcing ~230 `as` casts into files that should read as inert option
	 * tables. What used to make this signature dangerous was not the `any` but the
	 * unpredictable `options` argument, which {@link createActionRunner} now pins down.
	 */
	action?: (...args: any[]) => Promise<void> | void
	subcommands?: readonly ArgusCommandDefinition[]
}

/** Register a declarative command definition with Commander. */
export const defineCommand = (parent: Command, definition: ArgusCommandDefinition): Command => {
	const command = parent.command(definition.name)

	if (definition.alias) {
		command.alias(definition.alias)
	}
	for (const alias of definition.aliases ?? []) {
		command.alias(alias)
	}
	if (definition.description) {
		command.description(definition.description)
	}
	for (const argument of definition.arguments ?? []) {
		command.argument(argument.flags, argument.description)
	}
	for (const option of definition.options ?? []) {
		if (option.required) {
			addRequiredOption(command, option)
		} else {
			addOption(command, option)
		}
	}
	if (definition.examples && definition.examples.length > 0) {
		command.addHelpText('after', formatExamples(definition.examples))
	}

	definition.configure?.(command)
	for (const subcommand of definition.subcommands ?? []) {
		defineCommand(command, subcommand)
	}
	if (definition.action) {
		command.action(createActionRunner(command, definition.action))
	}

	return command
}

/**
 * Normalize Commander's action arguments once, for every command.
 *
 * Commander invokes an action as `(...declaredArgs, options, command)`, but which object
 * arrives as `options` shifts with `enablePositionalOptions` and with whether a command
 * is also a subcommand parent. Every register file that hit this invented its own
 * defensive fix — two verbatim copies of a `resolveActionOptions` helper, three
 * `command.optsWithGlobals?.() ?? options` call sites, and a 135-line shadow argv parser
 * — while 30-plus other actions did nothing at all. Deriving everything from the trailing
 * Command instance makes all of that unnecessary.
 */
const createActionRunner =
	(command: Command, action: NonNullable<ArgusCommandDefinition['action']>) =>
	async (...args: unknown[]): Promise<void> => {
		const last = args.at(-1)
		const instance = last instanceof Command ? last : command
		const declaredArgs = last instanceof Command ? args.slice(0, -2) : args

		await action(...declaredArgs, mergeCommandOptions(instance), instance)
	}

/**
 * Merge a command's options with its ancestors'.
 *
 * Not `optsWithGlobals()`: that reduces from the command outwards, so an ancestor's value
 * — including an untouched default — overwrites the subcommand's own. Here the chain is
 * walked root-to-leaf so the nearest command wins, and a value the user actually typed is
 * never replaced by a default from either direction.
 */
const mergeCommandOptions = (command: Command): Record<string, unknown> => {
	const chain: Command[] = []
	for (let current: Command | null = command; current; current = current.parent) {
		chain.unshift(current)
	}

	const merged: Record<string, unknown> = {}
	const typed = new Set<string>()
	for (const current of chain) {
		for (const [key, value] of Object.entries(current.opts())) {
			const fromCli = current.getOptionValueSource(key) === 'cli'
			if (typed.has(key) && !fromCli) {
				continue
			}
			merged[key] = value
			if (fromCli) {
				typed.add(key)
			}
		}
	}

	return merged
}

/** Register a list of command definitions in order. */
export const defineCommands = (parent: Command, definitions: readonly ArgusCommandDefinition[]): void => {
	for (const definition of definitions) {
		defineCommand(parent, definition)
	}
}

const addRequiredOption = (command: Command, option: ArgusCommandOption): void => {
	if (option.parser) {
		command.requiredOption(option.flags, option.description, option.parser, option.defaultValue)
		return
	}
	if (option.defaultValue === undefined) {
		command.requiredOption(option.flags, option.description)
		return
	}
	command.requiredOption(option.flags, option.description, option.defaultValue)
}

const addOption = (command: Command, option: ArgusCommandOption): void => {
	if (option.parser) {
		command.option(option.flags, option.description, option.parser, option.defaultValue)
		return
	}
	if (option.defaultValue === undefined) {
		command.option(option.flags, option.description)
		return
	}
	command.option(option.flags, option.description, option.defaultValue)
}

const formatExamples = (examples: readonly string[]): string => `\nExamples:\n${examples.map((example) => `  $ ${example}`).join('\n')}\n`
