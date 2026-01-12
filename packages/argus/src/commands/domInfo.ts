import type { DomInfoResponse, ErrorResponse } from '@vforsh/argus-core'
import { loadRegistry, pruneRegistry, removeWatcherAndPersist } from '../registry.js'
import { fetchJson } from '../httpClient.js'
import { formatDomInfo } from '../output/dom.js'

/** Options for the dom info command. */
export type DomInfoOptions = {
	selector: string
	all?: boolean
	outerHtmlMax?: string
	json?: boolean
}

/** Execute the dom info command for a watcher id. */
export const runDomInfo = async (id: string, options: DomInfoOptions): Promise<void> => {
	if (!options.selector || options.selector.trim() === '') {
		console.error('--selector is required')
		process.exitCode = 2
		return
	}

	const outerHtmlMaxChars = parsePositiveInt(options.outerHtmlMax)
	if (options.outerHtmlMax !== undefined && outerHtmlMaxChars === undefined) {
		console.error('--outer-html-max must be a positive integer')
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

	const url = `http://${watcher.host}:${watcher.port}/dom/info`
	let response: DomInfoResponse | ErrorResponse
	try {
		response = await fetchJson<DomInfoResponse | ErrorResponse>(url, {
			method: 'POST',
			body: {
				selector: options.selector,
				all: options.all ?? false,
				outerHtmlMaxChars,
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

	const successResp = response as DomInfoResponse

	if (options.json) {
		process.stdout.write(JSON.stringify(successResp))
		return
	}

	if (successResp.matches === 0) {
		console.error(`No element found for selector: ${options.selector}`)
		process.exitCode = 1
		return
	}

	const output = formatDomInfo(successResp.elements)
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
