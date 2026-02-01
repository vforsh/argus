import type { DomTreeResponse, ErrorResponse } from '@vforsh/argus-core'
import { formatDomTree } from '../output/dom.js'
import { createOutput } from '../output/io.js'
import { parsePositiveInt } from '../cli/parse.js'
import { requestWatcherJson, writeRequestError } from '../watchers/requestWatcher.js'

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
	if (!options.selector || options.selector.trim() === '') {
		output.writeWarn('--selector or --testid is required')
		process.exitCode = 2
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

	const result = await requestWatcherJson<DomTreeResponse | ErrorResponse>({
		id,
		path: '/dom/tree',
		method: 'POST',
		body: {
			selector: options.selector,
			depth,
			maxNodes,
			all: options.all ?? false,
			text: options.text,
		},
		timeoutMs: 30_000,
		returnErrorResponse: true,
	})

	if (!result.ok) {
		writeRequestError(result, output)
		return
	}

	const response = result.data
	if (!response.ok) {
		const errorResp = response as ErrorResponse
		if (options.json) {
			output.writeJson(response)
		} else {
			output.writeWarn(`Error: ${errorResp.error.message}`)
		}
		process.exitCode = 1
		return
	}

	const successResp = response as DomTreeResponse

	if (options.json) {
		output.writeJson(successResp)
		return
	}

	if (successResp.matches === 0) {
		output.writeWarn(`No element found for selector: ${options.selector}`)
		process.exitCode = 1
		return
	}

	const formatted = formatDomTree(successResp.roots, successResp.truncated, successResp.truncatedReason)
	output.writeHuman(formatted)
}
