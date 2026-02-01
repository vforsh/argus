import type { DomKeydownResponse, ErrorResponse } from '@vforsh/argus-core'
import { createOutput } from '../output/io.js'
import { requestWatcherJson, writeRequestError } from '../watchers/requestWatcher.js'

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

	const result = await requestWatcherJson<DomKeydownResponse | ErrorResponse>({
		id,
		path: '/dom/keydown',
		method: 'POST',
		body: {
			key: options.key,
			selector: options.selector,
			modifiers: options.modifiers,
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

	const successResp = response as DomKeydownResponse

	if (options.json) {
		output.writeJson(successResp)
		return
	}

	output.writeHuman(`Dispatched keydown: ${successResp.key}`)
}
