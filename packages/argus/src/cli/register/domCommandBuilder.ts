import type { ArgusCommandDefinition, ArgusCommandOption } from '../defineCommand.js'
import { resolveTestId } from '../../commands/resolveTestId.js'

type DomCommandOptions = {
	selector?: string
	testid?: string
	ref?: string
	json?: boolean
}

type DomSelectorCommandSpec = {
	name: string
	description: string
	examples: string[]
	alias?: string
	allowsAll?: boolean
	allowRef?: boolean
	textOption?: {
		flags: string
		description: string
	}
	waitOption?: boolean
	/** Extra command-specific options appended after the shared selector/testid plumbing. */
	options?: readonly ArgusCommandOption[]
	action: (id: string | undefined, options: any) => Promise<void>
}

/**
 * Build a DOM subcommand definition with the shared watcher-id, selector/testid,
 * and output plumbing. Keeping this declarative avoids the usual CLI drift where
 * similar commands slowly diverge.
 */
export const domSelectorCommand = (spec: DomSelectorCommandSpec): ArgusCommandDefinition => {
	const options: ArgusCommandOption[] = [
		{ flags: '--selector <css>', description: 'CSS selector to match element(s)' },
		{ flags: '--testid <id>', description: 'Shorthand for --selector "[data-testid=\'<id>\']"' },
	]
	if (spec.allowRef) {
		options.push({ flags: '--ref <elementRef>', description: 'Stable element ref from snapshot/locate output' })
	}
	if (spec.allowsAll !== false) {
		options.push({ flags: '--all', description: 'Allow multiple matches (default: error if >1 match)' })
	}
	if (spec.textOption) {
		options.push({ flags: spec.textOption.flags, description: spec.textOption.description })
	}
	if (spec.waitOption) {
		options.push({ flags: '--wait <duration>', description: 'Wait for selector to appear (e.g. 5s, 500ms)' })
	}
	options.push(...(spec.options ?? []))
	options.push({ flags: '--json', description: 'Output JSON for automation' })

	return {
		name: spec.name,
		alias: spec.alias,
		description: spec.description,
		arguments: [{ flags: '[id]', description: 'Watcher id to query' }],
		options,
		examples: spec.examples,
		action: async (id, options) => {
			if (!resolveTestId(options as DomCommandOptions)) {
				return
			}
			await spec.action(id, options as Record<string, unknown>)
		},
	}
}
