import type { DomHoverResponse, ErrorResponse } from '@vforsh/argus-core'
import { createOutput } from '../output/io.js'
import { requestWatcherJson, writeRequestError } from '../watchers/requestWatcher.js'

/** Options for the dom hover command. */
export type DomHoverOptions = {
	selector: string
	all?: boolean
	text?: string
	json?: boolean
}

/** Execute the dom hover command for a watcher id. */
export const runDomHover = async (id: string | undefined, options: DomHoverOptions): Promise<void> => {
	const output = createOutput(options)
	if (!options.selector || options.selector.trim() === '') {
		output.writeWarn('--selector or --testid is required')
		process.exitCode = 2
		return
	}

	const result = await requestWatcherJson<DomHoverResponse | ErrorResponse>({
		id,
		path: '/dom/hover',
		method: 'POST',
		body: {
			selector: options.selector,
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

	const successResp = response as DomHoverResponse

	if (options.json) {
		output.writeJson(successResp)
		return
	}

	if (successResp.matches === 0) {
		output.writeWarn(`No element found for selector: ${options.selector}`)
		process.exitCode = 1
		return
	}

	const label = successResp.hovered === 1 ? 'element' : 'elements'
	output.writeHuman(`Hovered ${successResp.hovered} ${label} for selector: ${options.selector}`)
}
