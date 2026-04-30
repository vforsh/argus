import type { DomHoverResponse } from '@vforsh/argus-core'
import { defineWatcherCommand } from '../cli/defineWatcherCommand.js'
import { describeElementTarget, requireElementTarget, writeNoElementFound } from './dom/shared.js'

/** Options for the dom hover command. */
export type DomHoverOptions = {
	selector?: string
	ref?: string
	all?: boolean
	text?: string
	json?: boolean
}

/** Execute the dom hover command for a watcher id. */
export const runDomHover = defineWatcherCommand<DomHoverOptions, DomHoverResponse>({
	build: (_args, options, output) => {
		const target = requireElementTarget({ selector: options.selector, ref: options.ref }, output)
		if (!target) return null

		return {
			path: '/dom/hover',
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
		const label = response.hovered === 1 ? 'element' : 'elements'
		output.writeHuman(`Hovered ${response.hovered} ${label} for ${describeElementTarget(target)}`)
	},
})
