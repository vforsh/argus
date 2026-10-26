import type { DomHoverResponse } from '@vforsh/argus-core'
import { defineActionCommand } from '../cli/defineWatcherCommand.js'
import { describeElementTarget, parseXY, requireElementTarget, writeNoElementFound } from './dom/shared.js'

/** Options for the dom hover command. */
export type DomHoverOptions = {
	selector?: string
	ref?: string
	pos?: string
	all?: boolean
	text?: string
	json?: boolean
}

/** Execute the dom hover command for a watcher id. */
export const runDomHover = defineActionCommand<DomHoverOptions, DomHoverResponse>({
	build: (_args, options, output) => {
		if (options.pos != null) {
			// A bare point, for canvas apps with no element to target (matches `click --pos`).
			const xy = parseXY(options.pos)
			if (!xy) {
				output.writeWarn('--pos must be in the format "x,y" (e.g. --pos 100,200)')
				process.exitCode = 2
				return null
			}
			if (options.selector?.trim() || options.ref?.trim()) {
				output.writeWarn('--pos cannot be combined with --selector, --testid, or --ref for hover')
				process.exitCode = 2
				return null
			}
			return { path: '/dom/hover', method: 'POST', body: { x: xy.x, y: xy.y } }
		}

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
		if (options.pos != null) {
			output.writeHuman(`Hovered at (${options.pos})`)
			return
		}
		const target = { selector: options.selector, ref: options.ref }
		if (response.matches === 0) {
			writeNoElementFound(target.selector ?? target.ref!, output)
			return
		}
		const label = response.hovered === 1 ? 'element' : 'elements'
		output.writeHuman(`Hovered ${response.hovered} ${label} for ${describeElementTarget(target)}`)
	},
})
