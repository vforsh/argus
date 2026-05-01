import type { DomKeydownResponse } from '@vforsh/argus-core'
import { defineWatcherCommand } from '../cli/defineWatcherCommand.js'

/** Options for the dom keydown command. */
export type DomKeydownOptions = {
	key: string
	selector?: string
	modifiers?: string
	json?: boolean
}

/** Execute the dom keydown command for a watcher id. */
export const runDomKeydown = defineWatcherCommand<DomKeydownOptions, DomKeydownResponse>({
	build: (_args, options, output) => {
		if (!options.key || options.key.trim() === '') {
			output.writeWarn('--key is required')
			process.exitCode = 2
			return null
		}
		return {
			path: '/dom/keydown',
			method: 'POST',
			body: {
				key: options.key,
				selector: options.selector,
				modifiers: options.modifiers,
			},
			timeoutMs: 30_000,
		}
	},
	formatHuman: (response, { output }) => {
		output.writeHuman(`Dispatched keydown: ${response.key}`)
	},
})
