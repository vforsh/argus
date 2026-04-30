import type { DomRemoveResponse } from '@vforsh/argus-core'
import { defineWatcherCommand } from '../cli/defineWatcherCommand.js'
import { requireSelector, writeNoElementFound } from './dom/shared.js'

/** Options for the dom remove command. */
export type DomRemoveOptions = {
	selector: string
	all?: boolean
	text?: string
	json?: boolean
}

/** Execute the dom remove command for a watcher id. */
export const runDomRemove = defineWatcherCommand<DomRemoveOptions, DomRemoveResponse>({
	build: (_args, options, output) => {
		const selector = requireSelector(options, output)
		if (!selector) return null

		return {
			path: '/dom/remove',
			method: 'POST',
			body: {
				selector,
				all: options.all ?? false,
				text: options.text,
			},
		}
	},
	formatHuman: (response, { output, options }) => {
		if (response.matches === 0) {
			writeNoElementFound(options.selector, output)
			return
		}
		const label = response.removed === 1 ? 'element' : 'elements'
		output.writeHuman(`Removed ${response.removed} ${label}`)
	},
})
