import type { DomHoverResponse } from '@vforsh/argus-core'
import { createOutput } from '../output/io.js'
import { requestWatcherAction } from '../watchers/requestWatcher.js'
import { requireSelector, writeNoElementFound } from './dom/shared.js'

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
	const selector = requireSelector(options, output)
	if (!selector) {
		return
	}

	const result = await requestWatcherAction<DomHoverResponse>(
		{
			id,
			path: '/dom/hover',
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

	const label = successResp.hovered === 1 ? 'element' : 'elements'
	output.writeHuman(`Hovered ${successResp.hovered} ${label} for selector: ${selector}`)
}
