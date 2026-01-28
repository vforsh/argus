import type { DomKeydownResponse, ErrorResponse } from '@vforsh/argus-core'
import { fetchJson } from '../httpClient.js'
import { createOutput } from '../output/io.js'
import { writeWatcherCandidates } from '../watchers/candidates.js'
import { resolveWatcher } from '../watchers/resolveWatcher.js'

/** Options for the dom keydown command. */
export type DomKeydownOptions = {
	key: string
	selector?: string
	modifiers?: string
	json?: boolean
}

/** Execute the dom keydown command for a watcher id. */
export const runDomKeydown = async (id: string | undefined, options: DomKeydownOptions): Promise<void> => {
	const output = createOutput(options)
	if (!options.key || options.key.trim() === '') {
		output.writeWarn('--key is required')
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
	const url = `http://${watcher.host}:${watcher.port}/dom/keydown`
	let response: DomKeydownResponse | ErrorResponse

	try {
		response = await fetchJson<DomKeydownResponse | ErrorResponse>(url, {
			method: 'POST',
			body: {
				key: options.key,
				selector: options.selector,
				modifiers: options.modifiers,
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

	const successResp = response as DomKeydownResponse

	if (options.json) {
		output.writeJson(successResp)
		return
	}

	output.writeHuman(`Dispatched keydown: ${successResp.key}`)
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
