import type { DomTreeResponse } from '@vforsh/argus-core'
import { formatDomTree } from '../output/dom.js'
import { createOutput } from '../output/io.js'
import { parsePositiveInt } from '../cli/parse.js'
import { requestWatcherAction } from '../watchers/requestWatcher.js'
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
export const runDomTree = async (id: string | undefined, options: DomTreeOptions): Promise<void> => {
	const output = createOutput(options)
	const selector = requireSelector(options, output)
	if (!selector) {
		return
	}

	const depth = parsePositiveInt(options.depth)
	if (options.depth !== undefined && depth === undefined) {
		output.writeWarn('--depth must be a positive integer')
		process.exitCode = 2
		return
	}

	const maxNodes = parsePositiveInt(options.maxNodes)
	if (options.maxNodes !== undefined && maxNodes === undefined) {
		output.writeWarn('--max-nodes must be a positive integer')
		process.exitCode = 2
		return
	}

	const result = await requestWatcherAction<DomTreeResponse>(
		{
			id,
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
		},
		output,
	)
	if (!result) {
		return
	}
	const successResp = result.data

	if (options.json) {
		output.writeJson(successResp)
		return
	}

	if (successResp.matches === 0) {
		writeNoElementFound(selector, output)
		return
	}

	const formatted = formatDomTree(successResp.roots, successResp.truncated, successResp.truncatedReason)
	output.writeHuman(formatted)
}
