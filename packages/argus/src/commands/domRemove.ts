import type { DomRemoveResponse } from '@vforsh/argus-core'
import { createOutput } from '../output/io.js'
import { requestWatcherAction } from '../watchers/requestWatcher.js'
import { requireSelector, writeNoElementFound } from './dom/shared.js'

/** Options for the dom remove command. */
export type DomRemoveOptions = {
	selector: string
	all?: boolean
	text?: string
	json?: boolean
}

/** Execute the dom remove command for a watcher id. */
export const runDomRemove = async (id: string | undefined, options: DomRemoveOptions): Promise<void> => {
	const output = createOutput(options)
	const selector = requireSelector(options, output)
	if (!selector) {
		return
	}

	const result = await requestWatcherAction<DomRemoveResponse>(
		{
			id,
			path: '/dom/remove',
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

	const label = successResp.removed === 1 ? 'element' : 'elements'
	output.writeHuman(`Removed ${successResp.removed} ${label}`)
}
