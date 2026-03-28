import type { DomInfoResponse } from '@vforsh/argus-core'
import { formatDomInfo } from '../output/dom.js'
import { createOutput } from '../output/io.js'
import { parsePositiveInt } from '../cli/parse.js'
import { requestWatcherAction } from '../watchers/requestWatcher.js'
import { requireSelector, writeNoElementFound } from './dom/shared.js'

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
	const selector = requireSelector(options, output)
	if (!selector) {
		return
	}

	const outerHtmlMaxChars = parsePositiveInt(options.outerHtmlMax)
	if (options.outerHtmlMax !== undefined && outerHtmlMaxChars === undefined) {
		output.writeWarn('--outer-html-max must be a positive integer')
		process.exitCode = 2
		return
	}

	const result = await requestWatcherAction<DomInfoResponse>(
		{
			id,
			path: '/dom/info',
			method: 'POST',
			body: {
				selector,
				all: options.all ?? false,
				outerHtmlMaxChars,
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

	const formatted = formatDomInfo(successResp.elements)
	output.writeHuman(formatted)
}
