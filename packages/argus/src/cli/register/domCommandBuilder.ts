import type { Command } from 'commander'
import { resolveTestId } from '../../commands/resolveTestId.js'

type DomCommandOptions = {
	selector?: string
	testid?: string
	json?: boolean
}

type DomSelectorCommandSpec = {
	name: string
	description: string
	examples: string[]
	alias?: string
	allowsAll?: boolean
	textOption?: {
		flags: string
		description: string
	}
	waitOption?: boolean
	configure?: (command: Command) => void
	action: (id: string | undefined, options: any) => Promise<void>
}

/**
 * Build DOM subcommands with the shared watcher-id, selector/testid, and output plumbing.
 * Keeping this declarative avoids the usual CLI drift where similar commands slowly diverge.
 */
export const registerDomSelectorCommand = (parent: Command, spec: DomSelectorCommandSpec): void => {
	const command = parent.command(spec.name).argument('[id]', 'Watcher id to query').description(spec.description)

	if (spec.alias) {
		command.alias(spec.alias)
	}

	command.option('--selector <css>', 'CSS selector to match element(s)')
	command.option('--testid <id>', 'Shorthand for --selector "[data-testid=\'<id>\']"')

	if (spec.allowsAll !== false) {
		command.option('--all', 'Allow multiple matches (default: error if >1 match)')
	}
	if (spec.textOption) {
		command.option(spec.textOption.flags, spec.textOption.description)
	}
	if (spec.waitOption) {
		command.option('--wait <duration>', 'Wait for selector to appear (e.g. 5s, 500ms)')
	}

	command.option('--json', 'Output JSON for automation')
	spec.configure?.(command)
	command.addHelpText('after', formatExamples(spec.examples))
	command.action(async (id, options) => {
		if (!resolveTestId(options as DomCommandOptions)) {
			return
		}
		await spec.action(id, options as Record<string, unknown>)
	})
}

const formatExamples = (examples: string[]): string => `\nExamples:\n${examples.map((example) => `  $ ${example}`).join('\n')}\n`
