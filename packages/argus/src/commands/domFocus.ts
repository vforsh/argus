import type { DomFocusResponse } from '@vforsh/argus-core'
import { createOutput } from '../output/io.js'
import { requestWatcherAction } from '../watchers/requestWatcher.js'
import { requireSelector, writeNoElementFound } from './dom/shared.js'

/** Options for the dom focus command. */
export type DomFocusOptions = {
	selector: string
	all?: boolean
	text?: string
	json?: boolean
}

/** Execute the dom focus command for a watcher id. */
export const runDomFocus = async (id: string | undefined, options: DomFocusOptions): Promise<void> => {
	const output = createOutput(options)
	const selector = requireSelector(options, output)
	if (!selector) {
		return
	}

	const result = await requestWatcherAction<DomFocusResponse>(
		{
			id,
			path: '/dom/focus',
			method: 'POST',
			body: {
				selector,
				all: options.all ?? false,
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

	const label = successResp.focused === 1 ? 'element' : 'elements'
	output.writeHuman(`Focused ${successResp.focused} ${label} for selector: ${selector}`)
}
