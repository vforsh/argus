import type { DomTreeResponse, ErrorResponse } from '@vforsh/argus-core'
import { loadRegistry, pruneRegistry, removeWatcherAndPersist } from '../registry.js'
import { fetchJson } from '../httpClient.js'
import { formatDomTree } from '../output/dom.js'

/** Options for the dom tree command. */
export type DomTreeOptions = {
	selector: string
	depth?: string
	maxNodes?: string
	all?: boolean
	json?: boolean
}

/** Execute the dom tree command for a watcher id. */
export const runDomTree = async (id: string, options: DomTreeOptions): Promise<void> => {
	if (!options.selector || options.selector.trim() === '') {
		console.error('--selector is required')
		process.exitCode = 2
		return
	}

	const depth = parsePositiveInt(options.depth)
	if (options.depth !== undefined && depth === undefined) {
		console.error('--depth must be a positive integer')
		process.exitCode = 2
		return
	}

	const maxNodes = parsePositiveInt(options.maxNodes)
	if (options.maxNodes !== undefined && maxNodes === undefined) {
		console.error('--max-nodes must be a positive integer')
		process.exitCode = 2
		return
	}

	let registry = await loadRegistry()
	registry = await pruneRegistry(registry)

	const watcher = registry.watchers[id]
	if (!watcher) {
		console.error(`Watcher not found: ${id}`)
		process.exitCode = 1
		return
	}

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
			},
			timeoutMs: 30_000,
			returnErrorResponse: true,
		})
	} catch (error) {
		console.error(`${watcher.id}: failed to reach watcher (${formatError(error)})`)
		registry = await removeWatcherAndPersist(registry, watcher.id)
		process.exitCode = 1
		return
	}

	if (!response.ok) {
		const errorResp = response as ErrorResponse
		if (options.json) {
			process.stdout.write(JSON.stringify(response))
		} else {
			console.error(`Error: ${errorResp.error.message}`)
		}
		process.exitCode = 1
		return
	}

	const successResp = response as DomTreeResponse

	if (options.json) {
		process.stdout.write(JSON.stringify(successResp))
		return
	}

	if (successResp.matches === 0) {
		console.error(`No element found for selector: ${options.selector}`)
		process.exitCode = 1
		return
	}

	const output = formatDomTree(successResp.roots, successResp.truncated, successResp.truncatedReason)
	process.stdout.write(output + '\n')
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
