import { Command } from 'commander'

export type ArgusCommandOption = {
	flags: string
	description: string
	defaultValue?: string | boolean | string[]
	required?: boolean
}

export type ArgusCommandDefinition = {
	name: string
	alias?: string
	description?: string
	arguments?: readonly { flags: string; description: string }[]
	options?: readonly ArgusCommandOption[]
	examples?: readonly string[]
	configure?: (command: Command) => void
	action?: (...args: any[]) => Promise<void> | void
	subcommands?: readonly ArgusCommandDefinition[]
}

/** Register a declarative command definition with Commander. */
export const defineCommand = (parent: Command, definition: ArgusCommandDefinition): Command => {
	const command = parent.command(definition.name)

	if (definition.alias) {
		command.alias(definition.alias)
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
		command.action(definition.action)
	}

	return command
}

/** Register a list of command definitions in order. */
export const defineCommands = (parent: Command, definitions: readonly ArgusCommandDefinition[]): void => {
	for (const definition of definitions) {
		defineCommand(parent, definition)
	}
}

const addRequiredOption = (command: Command, option: ArgusCommandOption): void => {
	if (option.defaultValue === undefined) {
		command.requiredOption(option.flags, option.description)
		return
	}
	command.requiredOption(option.flags, option.description, option.defaultValue)
}

const addOption = (command: Command, option: ArgusCommandOption): void => {
	if (option.defaultValue === undefined) {
		command.option(option.flags, option.description)
		return
	}
	command.option(option.flags, option.description, option.defaultValue)
}

const formatExamples = (examples: readonly string[]): string => `\nExamples:\n${examples.map((example) => `  $ ${example}`).join('\n')}\n`
