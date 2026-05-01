import type { DomInfoResponse } from '@vforsh/argus-core'
import { formatDomInfo } from '../output/dom.js'
import { parsePositiveInt } from '../cli/parse.js'
import { defineWatcherCommand, type WatcherRequestPlan } from '../cli/defineWatcherCommand.js'
import type { Output } from '../output/io.js'
import { requireElementTarget, writeNoElementFound } from './dom/shared.js'

/** Options for the dom info command. */
export type DomInfoOptions = {
	selector?: string
	ref?: string
	all?: boolean
	outerHtmlMax?: string
	text?: string
	json?: boolean
}

/** Execute the dom info command for a watcher id. */
export const runDomInfo = defineWatcherCommand<DomInfoOptions, DomInfoResponse>({
	build: (_args, options, output) => buildDomInfoPlan(options, output),
	formatHuman: (response, { output, options }) => {
		const target = { selector: options.selector, ref: options.ref }
		if (response.matches === 0) {
			writeNoElementFound(target.selector ?? target.ref!, output)
			return
		}

		const formatted = formatDomInfo(response.elements)
		output.writeHuman(formatted)
	},
})

const buildDomInfoPlan = (options: DomInfoOptions, output: Output): WatcherRequestPlan | null => {
	const target = requireElementTarget({ selector: options.selector, ref: options.ref }, output)
	if (!target) {
		return null
	}

	const outerHtmlMaxChars = parsePositiveInt(options.outerHtmlMax)
	if (options.outerHtmlMax !== undefined && outerHtmlMaxChars === undefined) {
		output.writeWarn('--outer-html-max must be a positive integer')
		process.exitCode = 2
		return null
	}

	return {
		path: '/dom/info',
		method: 'POST',
		body: {
			selector: target.selector,
			ref: target.ref,
			all: options.all ?? false,
			outerHtmlMaxChars,
			text: options.text,
		},
		timeoutMs: 30_000,
	}
}
