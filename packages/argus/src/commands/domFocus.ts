import type { DomFocusResponse } from '@vforsh/argus-core'
import { defineWatcherCommand } from '../cli/defineWatcherCommand.js'
import { describeElementTarget, requireElementTarget, writeNoElementFound } from './dom/shared.js'

/** Options for the dom focus command. */
export type DomFocusOptions = {
	selector?: string
	ref?: string
	all?: boolean
	text?: string
	json?: boolean
}

/** Execute the dom focus command for a watcher id. */
export const runDomFocus = defineWatcherCommand<DomFocusOptions, DomFocusResponse>({
	build: (_args, options, output) => {
		const target = requireElementTarget({ selector: options.selector, ref: options.ref }, output)
		if (!target) return null

		return {
			path: '/dom/focus',
			method: 'POST',
			body: {
				selector: target.selector,
				ref: target.ref,
				all: options.all ?? false,
				text: options.text,
			},
		}
	},
	formatHuman: (response, { output, options }) => {
		const target = { selector: options.selector, ref: options.ref }
		if (response.matches === 0) {
			writeNoElementFound(target.selector ?? target.ref!, output)
			return
		}
		const label = response.focused === 1 ? 'element' : 'elements'
		output.writeHuman(`Focused ${response.focused} ${label} for ${describeElementTarget(target)}`)
	},
})
