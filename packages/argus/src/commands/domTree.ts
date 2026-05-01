import type { DomTreeResponse } from '@vforsh/argus-core'
import { formatDomTree } from '../output/dom.js'
import { parsePositiveInt } from '../cli/parse.js'
import { defineWatcherCommand, type WatcherRequestPlan } from '../cli/defineWatcherCommand.js'
import type { Output } from '../output/io.js'
import { requireSelector, writeNoElementFound } from './dom/shared.js'

/** Options for the dom tree command. */
export type DomTreeOptions = {
	selector: string
	depth?: string
	maxNodes?: string
	all?: boolean
	text?: string
	json?: boolean
}

/** Execute the dom tree command for a watcher id. */
export const runDomTree = defineWatcherCommand<DomTreeOptions, DomTreeResponse>({
	build: (_args, options, output) => buildDomTreePlan(options, output),
	formatHuman: (response, { output, options }) => {
		if (response.matches === 0) {
			writeNoElementFound(options.selector, output)
			return
		}

		const formatted = formatDomTree(response.roots, response.truncated, response.truncatedReason)
		output.writeHuman(formatted)
	},
})

const buildDomTreePlan = (options: DomTreeOptions, output: Output): WatcherRequestPlan | null => {
	const selector = requireSelector(options, output)
	if (!selector) {
		return null
	}

	const depth = parsePositiveInt(options.depth, { allowZero: true })
	if (options.depth !== undefined && depth === undefined) {
		output.writeWarn('--depth must be a non-negative integer')
		process.exitCode = 2
		return null
	}

	const maxNodes = parsePositiveInt(options.maxNodes)
	if (options.maxNodes !== undefined && maxNodes === undefined) {
		output.writeWarn('--max-nodes must be a positive integer')
		process.exitCode = 2
		return null
	}

	return {
		path: '/dom/tree',
		method: 'POST',
		body: {
			selector,
			depth,
			maxNodes,
			all: options.all ?? false,
			text: options.text,
		},
		timeoutMs: 30_000,
	}
}
