import type { DomInfoResponse, ErrorResponse } from '@vforsh/argus-core'
import { formatDomInfo } from '../output/dom.js'
import { createOutput } from '../output/io.js'
import { parsePositiveInt } from '../cli/parse.js'
import { requestWatcherJson, writeRequestError } from '../watchers/requestWatcher.js'

/** Options for the dom info command. */
export type DomInfoOptions = {
	selector: string
	all?: boolean
	outerHtmlMax?: string
	text?: string
	json?: boolean
}

/** Execute the dom info command for a watcher id. */
export const runDomInfo = async (id: string | undefined, options: DomInfoOptions): Promise<void> => {
	const output = createOutput(options)
	if (!options.selector || options.selector.trim() === '') {
		output.writeWarn('--selector or --testid is required')
		process.exitCode = 2
		return
	}

	const outerHtmlMaxChars = parsePositiveInt(options.outerHtmlMax)
	if (options.outerHtmlMax !== undefined && outerHtmlMaxChars === undefined) {
		output.writeWarn('--outer-html-max must be a positive integer')
		process.exitCode = 2
		return
	}

	const result = await requestWatcherJson<DomInfoResponse | ErrorResponse>({
		id,
		path: '/dom/info',
		method: 'POST',
		body: {
			selector: options.selector,
			all: options.all ?? false,
			outerHtmlMaxChars,
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

	const successResp = response as DomInfoResponse

	if (options.json) {
		output.writeJson(successResp)
		return
	}

	if (successResp.matches === 0) {
		output.writeWarn(`No element found for selector: ${options.selector}`)
		process.exitCode = 1
		return
	}

	const formatted = formatDomInfo(successResp.elements)
	output.writeHuman(formatted)
}
