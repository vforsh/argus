import type { DomFillResponse, ErrorResponse } from '@vforsh/argus-core'
import { fetchJson } from '../httpClient.js'
import { createOutput } from '../output/io.js'
import { writeWatcherCandidates } from '../watchers/candidates.js'
import { resolveWatcher } from '../watchers/resolveWatcher.js'

/** Options for the dom fill command. */
export type DomFillOptions = {
	selector?: string
	name?: string
	all?: boolean
	text?: string
	json?: boolean
}

/** Execute the dom fill command for a watcher id. */
export const runDomFill = async (id: string | undefined, value: string, options: DomFillOptions): Promise<void> => {
	const output = createOutput(options)

	if (options.name && options.selector) {
		output.writeWarn('Cannot use both --name and --selector')
		process.exitCode = 2
		return
	}

	if (options.name) {
		options.selector = `[name="${options.name}"]`
	}

	if (!options.selector || options.selector.trim() === '') {
		output.writeWarn('--selector or --name is required')
		process.exitCode = 2
		return
	}

	if (typeof value !== 'string') {
		output.writeWarn('<value> argument is required')
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
	const url = `http://${watcher.host}:${watcher.port}/dom/fill`

	let response: DomFillResponse | ErrorResponse

	try {
		response = await fetchJson<DomFillResponse | ErrorResponse>(url, {
			method: 'POST',
			body: {
				selector: options.selector,
				value,
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

	const successResp = response as DomFillResponse

	if (options.json) {
		output.writeJson(successResp)
		return
	}

	if (successResp.matches === 0) {
		output.writeWarn(`No element found for selector: ${options.selector}`)
		process.exitCode = 1
		return
	}

	const elLabel = successResp.filled === 1 ? '1 element' : `${successResp.filled} elements`
	output.writeHuman(`Filled ${elLabel} for selector: ${options.selector}`)
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
