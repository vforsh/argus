import type { SnapshotResponse } from '@vforsh/argus-core'
import { defineWatcherCommand } from '../cli/defineWatcherCommand.js'
import { parsePositiveInt } from '../cli/parse.js'
import { formatAccessibilityTree } from '../output/accessibility.js'

/** Options for the snapshot command. */
export type SnapshotOptions = {
	selector?: string
	depth?: string
	interactive?: boolean
	json?: boolean
}

/** Execute the snapshot command for a watcher id. */
export const runSnapshot = defineWatcherCommand<SnapshotOptions, SnapshotResponse>({
	build: (_args, options, output) => {
		const depth = parsePositiveInt(options.depth)
		if (options.depth !== undefined && depth === undefined) {
			output.writeWarn('--depth must be a positive integer')
			process.exitCode = 2
			return null
		}
		return {
			path: '/snapshot',
			method: 'POST',
			body: {
				selector: options.selector,
				depth,
				interactive: options.interactive ?? false,
			},
		}
	},
	formatHuman: (response, { output }) => {
		if (response.roots.length === 0) {
			output.writeWarn('Accessibility tree is empty.')
			return
		}
		output.writeHuman(formatAccessibilityTree(response.roots))
	},
})
