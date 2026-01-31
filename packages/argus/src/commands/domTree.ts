import type { DomTreeResponse, ErrorResponse } from '@vforsh/argus-core'
import { fetchJson } from '../httpClient.js'
import { formatDomTree } from '../output/dom.js'
import { createOutput } from '../output/io.js'
import { writeWatcherCandidates } from '../watchers/candidates.js'
import { resolveWatcher } from '../watchers/resolveWatcher.js'

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
		output.writeWarn('--selector is required')
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

	const resolved = await resolveWatcher({ id })
	if (!resolved.ok) {
		output.writeWarn(resolved.error)
		if (resolved.candidates && resolved.candidates.length > 0) {
			writeWatcherCandidates(resolved.candidates, output)
			output.writeWarn('Hint: run `argus list` to see all watchers.')
		}
		process.exitCode = resolved.exitCode
		return
	}

	const { watcher } = resolved

	const url = `http://${watcher.host}:${watcher.port}/dom/tree`
	let response: DomTreeResponse | ErrorResponse
	try {
		response = await fetchJson<DomTreeResponse | ErrorResponse>(url, {
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
	} catch (error) {
		output.writeWarn(`${watcher.id}: failed to reach watcher (${formatError(error)})`)
		process.exitCode = 1
		return
	}

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

const parsePositiveInt = (value?: string): number | undefined => {
	if (value === undefined) {
		return undefined
	}

	const parsed = Number(value)
	if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
		return undefined
	}

	return parsed
}

const formatError = (error: unknown): string => {
	if (!error) {
		return 'unknown error'
	}
	if (error instanceof Error) {
		return error.message
	}
	return String(error)
}
